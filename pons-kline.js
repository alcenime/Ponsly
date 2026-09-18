/* =========================================================
   PONSLY — ON-CHAIN KLINE (OHLCV) BUILDER
   File: pons-kline.js
   Chain: Robinhood Chain (chain ID 4663)

   Reads Uniswap-V3-style Swap events straight from the pool
   contract via RPC and builds OHLCV candles ourselves.
   No GMGN, no third-party chart API, no API key.

   Confirms SWAP_TOPIC in pons.js against the standard V3
   Swap(address,address,int256,int256,uint160,uint128,int24)
   signature hash — matches, so this assumes a V3-style pool
   (sender, recipient, amount0, amount1, sqrtPriceX96,
   liquidity, tick). If PONS's factory is actually a V2 fork
   dressed up with a V3 ABI, the decodeSwapLog() below will
   throw obviously wrong numbers (e.g. NaN prices) rather than
   silently lying — check the price of the reference pool
   first before trusting historical candles from a new pool.

   IMPORTANT: RPC_URL below must match pons.js. It's duplicated
   here (not imported) so this file has no hard dependency on
   pons.js's internals staying exposed.
   ========================================================= */

(function () {
  "use strict";

  const RPC_URL =
    "https://ponsly-rpc-proxy.rifinzsmith477.workers.dev";

  // keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)")
  const SWAP_TOPIC =
    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

  const LOG_CHUNK_SIZE = 50000;
  const BLOCK_BATCH_SIZE = 25;
  const BLOCK_BATCH_DELAY_MS = 50;
  const LOG_CHUNK_DELAY_MS = 50;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  let rpcId = 1;

  async function rpc(method, params = []) {
    const id = rpcId++;

    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    });

    if (!response.ok) {
      throw new Error(`RPC HTTP ${response.status}`);
    }

    const json = await response.json();

    if (json.error) {
      throw new Error(
        json.error.message || `RPC error ${json.error.code || ""}`
      );
    }

    return json.result;
  }

  async function ethCall(to, data, blockTag = "latest") {
    return rpc("eth_call", [{ to, data }, blockTag]);
  }

  async function getBlockNumber() {
    return Number(BigInt(await rpc("eth_blockNumber")));
  }

  function normalizeAddress(value) {
    if (!value) return null;
    const str = String(value).trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(str)) return null;
    return str.toLowerCase();
  }

  function word(data, index) {
    const clean = String(data || "").replace(/^0x/, "");
    const start = index * 64;
    return clean.slice(start, start + 64);
  }

  function decodeAddress(data, index) {
    const w = word(data, index);
    if (!w || w.length < 64) return null;
    return "0x" + w.slice(24);
  }

  function decodeUint(data, index) {
    const w = word(data, index);
    if (!w) return 0n;
    try {
      return BigInt("0x" + w);
    } catch {
      return 0n;
    }
  }

  function decodeInt256(data, index) {
    let value = decodeUint(data, index);
    const SIGN_BIT = 2n ** 255n;
    const MODULUS = 2n ** 256n;
    if (value >= SIGN_BIT) value -= MODULUS;
    return value;
  }

  // ---------------------------------------------------------
  // Pool metadata: token0 / token1 / decimals (cached per pool)
  // ---------------------------------------------------------

  const poolMetaCache = new Map();

  async function getPoolMeta(poolAddress) {
    const pool = normalizeAddress(poolAddress);
    if (!pool) throw new Error("Invalid pool address");

    if (poolMetaCache.has(pool)) return poolMetaCache.get(pool);

    const [token0Data, token1Data] = await Promise.all([
      ethCall(pool, "0x0dfe1681"), // token0()
      ethCall(pool, "0xd21220a7")  // token1()
    ]);

    const token0 = normalizeAddress(decodeAddress(token0Data, 0));
    const token1 = normalizeAddress(decodeAddress(token1Data, 0));

    if (!token0 || !token1) {
      throw new Error(
        "Could not read token0/token1 from pool — is this really a V3-style pool?"
      );
    }

    const [dec0Data, dec1Data] = await Promise.all([
      ethCall(token0, "0x313ce567"), // decimals()
      ethCall(token1, "0x313ce567")
    ]);

    const meta = {
      pool,
      token0,
      token1,
      decimals0: Number(decodeUint(dec0Data, 0) || 18n),
      decimals1: Number(decodeUint(dec1Data, 0) || 18n)
    };

    poolMetaCache.set(pool, meta);
    return meta;
  }

  // ---------------------------------------------------------
  // Swap log scanning
  // ---------------------------------------------------------

  function decodeSwapLog(log) {
    const data = String(log.data || "");

    // last 3 bytes of the 5th word = int24 tick, two's-complement
    const tickHex = word(data, 4).slice(-6);
    let tick = parseInt(tickHex, 16);
    if (tick >= 2 ** 23) tick -= 2 ** 24;

    return {
      blockNumber: Number(BigInt(log.blockNumber)),
      transactionHash: log.transactionHash || null,
      logIndex: log.logIndex != null ? Number(BigInt(log.logIndex)) : null,
      amount0: decodeInt256(data, 0),
      amount1: decodeInt256(data, 1),
      sqrtPriceX96: decodeUint(data, 2),
      liquidity: decodeUint(data, 3),
      tick
    };
  }

  async function scanSwapLogs(poolAddress, fromBlock, toBlock, onProgress) {
    const pool = normalizeAddress(poolAddress);
    if (!pool) throw new Error("Invalid pool address");

    const logs = [];
    let from = Number(fromBlock);
    const end = Number(toBlock);

    while (from <= end) {
      const to = Math.min(from + LOG_CHUNK_SIZE - 1, end);

      try {
        const chunk = await rpc("eth_getLogs", [{
          address: pool,
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
          topics: [SWAP_TOPIC]
        }]);

        if (Array.isArray(chunk)) logs.push(...chunk);
      } catch (error) {
        console.warn("[PonslyKline] Log chunk failed:", from, to, error);
      }

      if (typeof onProgress === "function") {
        onProgress({ from, to, end, foundSoFar: logs.length });
      }

      from = to + 1;
      await sleep(LOG_CHUNK_DELAY_MS);
    }

    return logs.map(decodeSwapLog);
  }

  // ---------------------------------------------------------
  // Block timestamps (batched, deduped)
  // ---------------------------------------------------------

  async function getBlockTimestamps(blockNumbers) {
    const unique = Array.from(new Set(blockNumbers));
    const map = new Map();

    for (let i = 0; i < unique.length; i += BLOCK_BATCH_SIZE) {
      const batch = unique.slice(i, i + BLOCK_BATCH_SIZE);

      const results = await Promise.all(
        batch.map((bn) =>
          rpc("eth_getBlockByNumber", ["0x" + bn.toString(16), false]).catch(
            () => null
          )
        )
      );

      results.forEach((block, idx) => {
        if (block && block.timestamp) {
          map.set(batch[idx], Number(BigInt(block.timestamp)));
        }
      });

      await sleep(BLOCK_BATCH_DELAY_MS);
    }

    return map;
  }

  // ---------------------------------------------------------
  // Price + OHLCV
  // ---------------------------------------------------------

  // Returns price of `baseToken` denominated in the pool's OTHER token,
  // in human units (already decimal-adjusted).
  function computePrice(swap, meta, baseToken) {
    const sqrt = Number(swap.sqrtPriceX96) / 2 ** 96;
    const rawPrice = sqrt * sqrt; // token1 per token0, raw units

    const humanPriceT1PerT0 =
      rawPrice * 10 ** (meta.decimals0 - meta.decimals1);

    const base = normalizeAddress(baseToken);
    const token0IsBase = meta.token0 === base;

    if (token0IsBase) return humanPriceT1PerT0;
    return humanPriceT1PerT0 === 0 ? 0 : 1 / humanPriceT1PerT0;
  }

  function volumeForSwap(swap, meta, baseToken) {
    const base = normalizeAddress(baseToken);
    const token0IsBase = meta.token0 === base;

    const rawAmount = token0IsBase ? swap.amount0 : swap.amount1;
    const decimals = token0IsBase ? meta.decimals0 : meta.decimals1;

    const abs = rawAmount < 0n ? -rawAmount : rawAmount;
    return Number(abs) / 10 ** decimals;
  }

  /*
   * getSwapCandles({ poolAddress, baseToken, fromBlock, toBlock,
   *                   intervalSeconds, onProgress })
   *
   * baseToken = the token whose price (in the OTHER pool token)
   * you want charted, e.g. the PONS token address if you want a
   * PONS/ETH chart.
   *
   * Returns candles: [{ time, open, high, low, close, volume }],
   * `time` = unix seconds, `volume` = base-token amount traded
   * in that bucket.
   */
  async function getSwapCandles(options = {}) {
    const {
      poolAddress,
      baseToken,
      fromBlock,
      toBlock,
      intervalSeconds = 60,
      onProgress
    } = options;

    if (!poolAddress || !baseToken) {
      throw new Error("poolAddress and baseToken are required");
    }

    const meta = await getPoolMeta(poolAddress);

    const end = toBlock != null ? Number(toBlock) : await getBlockNumber();
    const start = fromBlock != null ? Number(fromBlock) : 0;

    const swaps = await scanSwapLogs(poolAddress, start, end, onProgress);
    if (swaps.length === 0) return [];

    const timestamps = await getBlockTimestamps(
      swaps.map((s) => s.blockNumber)
    );

    const points = swaps
      .map((swap) => {
        const ts = timestamps.get(swap.blockNumber);
        if (ts == null) return null;
        return {
          time: ts,
          blockNumber: swap.blockNumber,
          price: computePrice(swap, meta, baseToken),
          volume: volumeForSwap(swap, meta, baseToken)
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.time - b.time || a.blockNumber - b.blockNumber);

    if (points.length === 0) return [];

    const candles = [];
    let bucketStart =
      Math.floor(points[0].time / intervalSeconds) * intervalSeconds;
    let bucket = [];

    function flush() {
      if (bucket.length === 0) return;
      const prices = bucket.map((p) => p.price);
      candles.push({
        time: bucketStart,
        open: prices[0],
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: prices[prices.length - 1],
        volume: bucket.reduce((sum, p) => sum + p.volume, 0)
      });
    }

    for (const point of points) {
      const pointBucket =
        Math.floor(point.time / intervalSeconds) * intervalSeconds;

      if (pointBucket !== bucketStart) {
        flush();
        bucketStart = pointBucket;
        bucket = [];
      }

      bucket.push(point);
    }
    flush();

    return candles;
  }

  window.PonslyKline = {
    getPoolMeta,
    scanSwapLogs,
    getBlockTimestamps,
    getSwapCandles
  };
})();
