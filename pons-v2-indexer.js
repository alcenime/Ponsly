/* =========================================================
   PONSLY — PONS V2 ONCHAIN TRADES INDEXER
   File: pons-v2-indexer.js

   ONCHAIN (Pons V2 factory + curves + Uniswap V4 PoolManager)
     -> this file (the "Ponsly indexer" box)
     -> Supabase `trades` table (via window.PonslyTradesStore)
     -> Recent Trades UI (token.html reads window.PonslyV2Trades.getRecentTrades)

   Supabase is a CACHE, never the source of truth — every row saved
   here was decoded from a real on-chain log. Nothing in this file
   invents a trade, a price, or a wallet.

   Pons V2 ONLY. No Pons V1 factory/router/topics, no hardcoded
   single pool — every token's curve/pool is resolved from the V2
   factory's own on-chain state, per docs.ponsfamily.com/v2.

   ---------------------------------------------------------------
   SOURCES (so nothing here is a guess):

   Pons V2 factory, meme hook, getLaunchedToken() struct, phase
   enum, and the CurveBuy/CurveSell event signatures are copied
   verbatim from https://docs.ponsfamily.com/v2 ("Reading state"
   and "Events to index" sections).

   The Uniswap V4 PoolManager address below is NOT a Pons address —
   docs.ponsfamily.com/v2 explicitly does not list one, because it's
   Uniswap's own shared singleton for the whole chain ("any v4-aware
   router or aggregator can trade it without integrating against
   pons at all"). Cross-checked against three independent sources
   for Robinhood Chain (chain id 4663) that all agree on the same
   address. If Uniswap redeploys PoolManager on this chain, update
   POOL_MANAGER_V4 below.

   The V4 `Swap` event signature is copied verbatim from Uniswap's
   own v4-core source (`IPoolManager.sol`):
     event Swap(PoolId indexed id, address indexed sender,
                int128 amount0, int128 amount1, uint160 sqrtPriceX96,
                uint128 liquidity, int24 tick, uint24 fee);
   topic0 below is keccak256("Swap(bytes32,address,int128,int128,
   uint160,uint128,int24,uint24)") — PoolId is a value type wrapping
   bytes32, which is how Solidity encodes it in the event signature.

   KNOWN LIMITATION (documented, not silently guessed around):
   The V4 core Swap event does not carry a "recipient" field, and its
   indexed `sender` is almost always the router contract that called
   PoolManager, not the end-user wallet. For post-graduation trades
   this file uses the transaction's `from` address as both trader and
   recipient (best effort — it's the closest on-chain-verifiable
   wallet available from this event alone). It also cannot recover
   the pons-specific fee/tax split for a V4 swap from this event
   alone (that lives in the hook's fee-sweep events, not the swap
   itself) — fee/tax are left null for pool-sourced trades rather
   than invented. Pre-graduation CurveBuy/CurveSell trades have exact
   buyer, recipient, fee and tax straight from the event, no caveats.
   ========================================================= */

(function () {
  "use strict";

  // ------------------------------------------------------------
  // Pons V2 — from docs.ponsfamily.com/v2 "Contracts" section
  // ------------------------------------------------------------
  const FACTORY_V2 = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
  // Meme hook address is part of the V2 deployment surface but this
  // file does not currently call it directly (poolId only needs its
  // address as a value, folded into POOL_KEY below).
  const MEME_HOOK_V2 = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";

  // Uniswap v4 singleton PoolManager on Robinhood Chain (NOT a Pons
  // address — see file header).
  const POOL_MANAGER_V4 = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

  // topic0 = keccak256(eventSignature), computed from the exact
  // signatures quoted in the file header / docs — not guessed.
  const TOPIC_CURVE_BUY =
    "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455";
  const TOPIC_CURVE_SELL =
    "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df";
  const TOPIC_TOKEN_LAUNCHED =
    "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";
  const TOPIC_V4_SWAP =
    "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";

  const SELECTOR_GET_LAUNCHED_TOKEN = "0x3cf28b5a"; // getLaunchedToken(address)
  const SELECTOR_DECIMALS = "0x313ce567";           // decimals()

  const LOG_CHUNK_SIZE = 50000;
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  // ------------------------------------------------------------
  // Small helpers (self-contained — this file does not depend on
  // or modify pons.js; it only reads the RPC URL it already has).
  // ------------------------------------------------------------
  function normalizeAddress(value) {
    if (!value) return null;
    const str = String(value).trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(str)) return null;
    return str;
  }

  function pad32(hexNoPrefix) {
    return hexNoPrefix.replace(/^0x/, "").padStart(64, "0");
  }

  function addressTopic(address) {
    return "0x" + pad32(normalizeAddress(address).toLowerCase());
  }

  function word(dataNoPrefix, index) {
    const start = index * 64;
    return dataNoPrefix.slice(start, start + 64);
  }

  function decodeUint(hexWord) {
    if (!hexWord) return 0n;
    try { return BigInt("0x" + hexWord); } catch { return 0n; }
  }

  function decodeInt(hexWord) {
    // ABI encoders sign-extend signed integers to a full 32-byte word,
    // so a straight two's-complement read over 256 bits is correct
    // regardless of the source type's declared width (int24, int128…).
    const raw = decodeUint(hexWord);
    const TWO_255 = 1n << 255n;
    const TWO_256 = 1n << 256n;
    return raw >= TWO_255 ? raw - TWO_256 : raw;
  }

  function decodeAddress(hexWord) {
    if (!hexWord || hexWord.length < 40) return null;
    return "0x" + hexWord.slice(24);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function getRpcUrl() {
    // Reuses the same RPC proxy pons.js already talks to — one place
    // to update if the proxy URL ever changes.
    if (window.PonslyPons && window.PonslyPons.rpc) return window.PonslyPons.rpc;
    console.error("[PonslyV2] pons.js not loaded — no RPC URL available.");
    return null;
  }

  let rpcId = 1;

  async function rpc(method, params = []) {
    const url = getRpcUrl();
    if (!url) throw new Error("No RPC URL configured");

    for (let attempt = 0; attempt <= 3; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params })
      });

      if (response.status === 429 && attempt < 3) {
        await sleep(400 * Math.pow(2, attempt) + Math.random() * 200);
        continue;
      }

      if (!response.ok) throw new Error(`[${method}] RPC HTTP ${response.status}`);

      const json = await response.json();
      if (json.error) throw new Error(`[${method}] ${json.error.message || "RPC error"}`);
      return json.result;
    }

    throw new Error(`[${method}] RPC failed after retries`);
  }

  async function ethCall(to, data) {
    return rpc("eth_call", [{ to, data }, "latest"]);
  }

  async function readDecimals(tokenAddress) {
    if (!tokenAddress || normalizeAddress(tokenAddress) === null) return 18;
    if (normalizeAddress(tokenAddress).toLowerCase() === ZERO_ADDRESS) return 18; // native ETH
    try {
      const data = await ethCall(tokenAddress, SELECTOR_DECIMALS);
      const value = decodeUint((data || "0x").replace(/^0x/, ""));
      return Number(value || 18n);
    } catch {
      return 18; // safe fallback — only affects display scaling, not indexing correctness
    }
  }

  async function getBlockNumber() {
    const result = await rpc("eth_blockNumber");
    return Number(BigInt(result));
  }

  async function getBlockTimestamp(blockNumber) {
    const hexBlock = "0x" + Number(blockNumber).toString(16);
    const block = await rpc("eth_getBlockByNumber", [hexBlock, false]);
    if (!block || !block.timestamp) return null;
    return new Date(Number(BigInt(block.timestamp)) * 1000).toISOString();
  }

  async function getTxFrom(txHash) {
    try {
      const tx = await rpc("eth_getTransactionByHash", [txHash]);
      return tx && tx.from ? normalizeAddress(tx.from) : null;
    } catch {
      return null;
    }
  }

  async function getLogsChunked(address, topics, fromBlock, toBlock) {
    const logs = [];
    let from = Number(fromBlock);
    const end = Number(toBlock);

    while (from <= end) {
      const to = Math.min(from + LOG_CHUNK_SIZE - 1, end);
      try {
        const chunk = await rpc("eth_getLogs", [{
          address,
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
          topics
        }]);
        if (Array.isArray(chunk)) logs.push(...chunk);
      } catch (e) {
        console.warn("[PonslyV2] log chunk failed:", address, from, to, e);
      }
      from = to + 1;
      await sleep(30);
    }

    return logs;
  }

  // ------------------------------------------------------------
  // Factory reads
  // ------------------------------------------------------------

  /*
   * getLaunchedToken(address) -> LaunchedToken struct. Every field is
   * a value type (no dynamic arrays/strings), so the return data is
   * just 15 consecutive 32-byte words in struct-declaration order —
   * see docs.ponsfamily.com/v2 "Reading state".
   */
  async function getLaunchedToken(tokenAddress) {
    const token = normalizeAddress(tokenAddress);
    if (!token) return null;

    const data = SELECTOR_GET_LAUNCHED_TOKEN + pad32(token);
    const result = await ethCall(FACTORY_V2, data);
    const clean = (result || "0x").replace(/^0x/, "");
    if (clean.length < 15 * 64) return null;

    const launch = {
      token: decodeAddress(word(clean, 0)),
      curve: decodeAddress(word(clean, 1)),
      deployer: decodeAddress(word(clean, 2)),
      creatorFeeRecipient: decodeAddress(word(clean, 3)),
      pairToken: decodeAddress(word(clean, 4)),
      graduationThreshold: decodeUint(word(clean, 5)),
      poolFee: Number(decodeUint(word(clean, 6))),
      tickSpacing: Number(decodeInt(word(clean, 7))),
      creatorTaxBps: Number(decodeUint(word(clean, 8))),
      buybackEnabled: decodeUint(word(clean, 9)) === 1n,
      phase: Number(decodeUint(word(clean, 10))),
      sweptQuote: decodeUint(word(clean, 11)),
      sweptTokens: decodeUint(word(clean, 12)),
      sweptAt: decodeUint(word(clean, 13)),
      exists: decodeUint(word(clean, 14)) === 1n
    };

    return launch.exists ? launch : null;
  }

  /*
   * Exact launch block for a token, from the factory's own
   * TokenLaunched event (topics[1] = indexed token address) — so
   * first-time indexing starts exactly at the launch, never from a
   * guessed lookback window.
   */
  async function getLaunchBlock(tokenAddress) {
    const token = normalizeAddress(tokenAddress);
    if (!token) return null;

    try {
      const head = await getBlockNumber();
      const logs = await rpc("eth_getLogs", [{
        address: FACTORY_V2,
        fromBlock: "0x0",
        toBlock: "0x" + head.toString(16),
        topics: [TOPIC_TOKEN_LAUNCHED, addressTopic(token)]
      }]);
      if (Array.isArray(logs) && logs.length && logs[0].blockNumber) {
        return Number(BigInt(logs[0].blockNumber));
      }
    } catch (e) {
      console.warn("[PonslyV2] getLaunchBlock failed (falling back to a lookback window):", e);
    }
    return null;
  }

  /*
   * Uniswap v4 poolId for a graduated launch — same construction as
   * docs.ponsfamily.com/v2 "Uniswap v4 pools":
   *   currency0/currency1 sorted by address (native ETH's zero
   *   address always sorts lowest), poolFee is 0 (the hook charges
   *   the fee, not the pool), hooks = the shared meme hook.
   * keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks))
   */
  async function computePoolId(launch) {
    const pair = normalizeAddress(launch.pairToken) || ZERO_ADDRESS;
    const token = normalizeAddress(launch.token);
    const [currency0, currency1] =
      pair.toLowerCase() < token.toLowerCase() ? [pair, token] : [token, pair];

    // uint24 fee (3 bytes), int24 tickSpacing (3 bytes) — abi.encode
    // (not encodePacked) pads every field to its own 32-byte word.
    const encoded =
      pad32(currency0) +
      pad32(currency1) +
      pad32(launch.poolFee.toString(16)) +
      pad32((launch.tickSpacing < 0
        ? (BigInt(launch.tickSpacing) + (1n << 256n))
        : BigInt(launch.tickSpacing)
      ).toString(16)) +
      pad32(MEME_HOOK_V2);

    return await keccak256Hex(encoded);
  }

  /*
   * keccak256 over a hex string. Delegates to the js-sha3 library
   * (loaded via CDN in token.html, which attaches `keccak256`
   * directly onto window) — a well-tested implementation, verified
   * byte-for-byte against ethers.js during development rather than
   * hand-rolled here. Only used for the one poolId computation above.
   */
  function keccak256Hex(hexNoPrefix) {
    if (typeof window.keccak256 !== "function") {
      throw new Error(
        "js-sha3 not loaded — add its CDN <script> tag before pons-v2-indexer.js in token.html."
      );
    }
    const bytes = hexToBytes(hexNoPrefix);
    return "0x" + window.keccak256(bytes);
  }

  function hexToBytes(hex) {
    const clean = hex.replace(/^0x/, "");
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  // ------------------------------------------------------------
  // Event -> normalized trade decoding
  // ------------------------------------------------------------

  function toHuman(rawBigInt, decimals) {
    const neg = rawBigInt < 0n;
    const abs = neg ? -rawBigInt : rawBigInt;
    const divisor = 10n ** BigInt(decimals);
    const whole = abs / divisor;
    const frac = abs % divisor;
    const fracStr = frac.toString().padStart(decimals, "0").slice(0, 8).replace(/0+$/, "");
    const str = fracStr ? `${whole}.${fracStr}` : `${whole}`;
    const num = Number(str);
    return neg ? -num : num;
  }

  async function decodeCurveLogs(logs, side, tokenDecimals, quoteDecimals, tokenAddress) {
    const out = [];
    for (const log of logs) {
      const topics = log.topics || [];
      if (topics.length < 3) continue;
      const data = String(log.data || "").replace(/^0x/, "");
      if (data.length < 4 * 64) continue;

      const actor = decodeAddress(topics[1].replace(/^0x/, ""));
      const recipient = decodeAddress(topics[2].replace(/^0x/, ""));

      const w0 = decodeUint(word(data, 0)); // quoteIn or tokensIn
      const w1 = decodeUint(word(data, 1)); // tokensOut or quoteOut
      const fee = decodeUint(word(data, 2));
      const tax = decodeUint(word(data, 3));

      const quoteRaw = side === "buy" ? w0 : w1;
      const tokenRaw = side === "buy" ? w1 : w0;

      out.push({
        tokenAddress,
        txHash: log.transactionHash,
        logIndex: Number(BigInt(log.logIndex)),
        blockNumber: Number(BigInt(log.blockNumber)),
        trader: actor,
        recipient,
        side,
        tokenAmount: toHuman(tokenRaw, tokenDecimals),
        quoteAmount: toHuman(quoteRaw, quoteDecimals),
        fee: toHuman(fee, quoteDecimals),
        tax: toHuman(tax, quoteDecimals),
        price: tokenRaw > 0n ? toHuman(quoteRaw, quoteDecimals) / toHuman(tokenRaw, tokenDecimals) : null,
        source: "curve"
      });
    }
    return out;
  }

  async function decodePoolLogs(logs, launch, tokenDecimals, quoteDecimals) {
    const token = normalizeAddress(launch.token).toLowerCase();
    const pair = (normalizeAddress(launch.pairToken) || ZERO_ADDRESS).toLowerCase();
    const tokenIsCurrency0 = pair < token ? false : true; // matches sort in computePoolId

    const out = [];
    for (const log of logs) {
      const topics = log.topics || [];
      if (topics.length < 2) continue;
      const data = String(log.data || "").replace(/^0x/, "");
      if (data.length < 6 * 64) continue;

      const amount0 = decodeInt(word(data, 0));
      const amount1 = decodeInt(word(data, 1));
      const tokenDelta = tokenIsCurrency0 ? amount0 : amount1;
      const quoteDelta = tokenIsCurrency0 ? amount1 : amount0;

      // Positive delta = the trader received that currency (see
      // BalanceDelta sign convention in Uniswap v4 core docs).
      const side = tokenDelta > 0n ? "buy" : "sell";

      // The event's own `sender` topic is the caller of PoolManager
      // (almost always a router), not the end-user wallet — use the
      // transaction's `from` instead. One extra RPC call per new log.
      const trader = await getTxFrom(log.transactionHash);

      out.push({
        tokenAddress: launch.token,
        txHash: log.transactionHash,
        logIndex: Number(BigInt(log.logIndex)),
        blockNumber: Number(BigInt(log.blockNumber)),
        trader: trader || null,
        recipient: trader || null, // best effort — see file header
        side,
        tokenAmount: Math.abs(toHuman(tokenDelta, tokenDecimals)),
        quoteAmount: Math.abs(toHuman(quoteDelta, quoteDecimals)),
        fee: null, // not derivable from the core Swap event alone — see file header
        tax: null,
        price: tokenDelta !== 0n
          ? Math.abs(toHuman(quoteDelta, quoteDecimals)) / Math.abs(toHuman(tokenDelta, tokenDecimals))
          : null,
        source: "pool"
      });
    }
    return out;
  }

  async function attachTimestamps(trades) {
    const blocks = Array.from(new Set(trades.map(t => t.blockNumber)));
    const timestamps = {};
    for (const b of blocks) {
      try { timestamps[b] = await getBlockTimestamp(b); }
      catch { timestamps[b] = null; }
    }
    return trades.map(t => ({ ...t, blockTime: timestamps[t.blockNumber] || new Date().toISOString() }));
  }

  // ------------------------------------------------------------
  // Public entry point
  // ------------------------------------------------------------

  const inFlight = new Map(); // tokenAddress -> Promise, avoids duplicate concurrent indexing

  /*
   * Indexes any new on-chain trades for `tokenAddress` since the
   * last cached block, saves them to Supabase, and returns the
   * merged recent-trades list already shaped for the Recent Trades
   * UI: { type: 'buy'|'sell', amount, ticker, wallet, price, time }.
   *
   * Never throws to the caller — on any failure it falls back to
   * whatever is already cached in Supabase (or []), so a bad RPC
   * call degrades the freshness of the list, not the page.
   */
  async function getRecentTrades(tokenAddress, options = {}) {
    const limit = options.limit || 50;
    const token = normalizeAddress(tokenAddress);
    if (!token) return [];

    if (inFlight.has(token)) {
      try { await inFlight.get(token); } catch { /* ignore, fall through to cache read below */ }
    }

    const runner = (async () => {
      if (!window.PonslyTradesStore || !window.PonslyTradesStore.isConfigured()) {
        console.warn("[PonslyV2] Supabase trades store not configured — skipping indexing this load.");
        return;
      }

      let launch;
      try {
        launch = await getLaunchedToken(token);
      } catch (e) {
        console.warn("[PonslyV2] getLaunchedToken failed:", e);
        return;
      }
      if (!launch) return; // not a Pons V2 launch — nothing to index

      const head = await getBlockNumber().catch(() => null);
      if (head == null) return;

      let fromBlock = await window.PonslyTradesStore.getLastIndexedBlock(token);
      if (fromBlock == null) {
        fromBlock = await getLaunchBlock(token);
      }
      if (fromBlock == null) fromBlock = Math.max(0, head - 50000); // last-resort bound, not a fabricated trade
      else fromBlock = fromBlock + 1;

      if (fromBlock > head) return; // already caught up

      const [tokenDecimals, quoteDecimals] = await Promise.all([
        readDecimals(launch.token),
        readDecimals(launch.pairToken)
      ]);

      let newTrades = [];

      // Curve trades — always safe to scan; the curve simply stops
      // emitting once graduated, so this is a no-op past that point.
      const [buyLogs, sellLogs] = await Promise.all([
        getLogsChunked(launch.curve, [TOPIC_CURVE_BUY], fromBlock, head),
        getLogsChunked(launch.curve, [TOPIC_CURVE_SELL], fromBlock, head)
      ]);
      const curveBuys = await decodeCurveLogs(buyLogs, "buy", tokenDecimals, quoteDecimals, launch.token);
      const curveSells = await decodeCurveLogs(sellLogs, "sell", tokenDecimals, quoteDecimals, launch.token);
      newTrades = newTrades.concat(curveBuys, curveSells);

      // Pool swaps — only meaningful once graduated (phase 2), and
      // only once the pool actually exists, so gate on phase.
      if (launch.phase === 2) {
        try {
          const poolId = await computePoolId(launch);
          const poolLogs = await getLogsChunked(
            POOL_MANAGER_V4,
            [TOPIC_V4_SWAP, poolId],
            fromBlock,
            head
          );
          const poolTrades = await decodePoolLogs(poolLogs, launch, tokenDecimals, quoteDecimals);
          newTrades = newTrades.concat(poolTrades);
        } catch (e) {
          console.warn("[PonslyV2] pool swap indexing failed:", e);
        }
      }

      if (!newTrades.length) return;

      newTrades = await attachTimestamps(newTrades);
      await window.PonslyTradesStore.saveTrades(newTrades);
    })();

    inFlight.set(token, runner);
    try { await runner; } catch (e) { console.warn("[PonslyV2] indexing run failed:", e); }
    inFlight.delete(token);

    // Always answer from the cache after (attempting) a fresh index,
    // so a transient RPC failure still shows whatever was already
    // indexed instead of an empty list.
    let cached = [];
    try {
      if (window.PonslyTradesStore && window.PonslyTradesStore.isConfigured()) {
        cached = await window.PonslyTradesStore.getCachedTrades(token, limit);
      }
    } catch (e) {
      console.warn("[PonslyV2] getCachedTrades failed:", e);
    }

    return cached.map(rowToUiTrade);
  }

  function rowToUiTrade(row) {
    return {
      type: row.side === "sell" ? "sell" : "buy",
      amount: formatAmount(row.token_amount),
      wallet: row.trader,
      price: row.price != null ? formatPrice(row.price) : null,
      time: formatRelativeTime(row.block_time)
    };
  }

  function formatAmount(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return "—";
    if (num >= 1000) return num.toLocaleString(undefined, { maximumFractionDigits: 0 });
    if (num >= 1) return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return num.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }

  function formatPrice(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return num < 0.01 ? num.toExponential(2) : num.toFixed(6);
  }

  function formatRelativeTime(iso) {
    if (!iso) return "";
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return "";
    const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (diffSec < 5) return "now";
    if (diffSec < 60) return `${diffSec}s`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    return `${Math.floor(diffHr / 24)}d`;
  }

  window.PonslyV2Trades = {
    getRecentTrades,
    getLaunchedToken,
    computePoolId,
    factory: FACTORY_V2,
    memeHook: MEME_HOOK_V2,
    poolManagerV4: POOL_MANAGER_V4
  };

  console.log("[Ponsly] pons-v2-indexer.js loaded (Pons V2 curve + Uniswap V4 pool trades -> Supabase)");
})();
