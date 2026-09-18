/* =========================================================
   PONSLY — PONS V1 ONCHAIN ADAPTER
   File: pons.js
   Chain: Robinhood Chain
   Chain ID: 4663

   READ-ONLY ADAPTER
   ========================================================= */

(function () {
  "use strict";

  const CHAIN_ID = 4663;

  const RPC_URL =
    /*
     * IMPORTANT: rpc.mainnet.chain.robinhood.com does not send
     * CORS headers, so calling it directly from a browser fails
     * with "Failed to fetch". This points at the Ponsly RPC
     * proxy (Cloudflare Worker) instead, which forwards to the
     * real RPC server-to-server and adds CORS headers back.
     *
     * Replace this with YOUR deployed Worker URL after step 2
     * of the Cloudflare deploy (something like
     * "https://ponsly-rpc-proxy.<your-subdomain>.workers.dev").
     */
    "https://ponsly-rpc-proxy.rifinzsmith477.workers.dev";

  const EXPLORER_URL =
    "https://robinhoodchain.blockscout.com";

  const WETH =
    "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

  const ACTIVE_FACTORY =
    "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";

  const LEGACY_FACTORY =
    "0x0c37a24F5D23A486FA692d1500881d698B1F77a4";

  const V3_FACTORY =
    "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";

  const QUOTER_V2 =
    "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";

  const SWAP_ROUTER =
    "0xCaf681a66D020601342297493863E78C959E5cb2";

  const POSITION_MANAGER =
    "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";

  const PONS_REFERENCE_TOKEN =
    "0x39dBED3a2bd333467115dE45665cC57F813C4571";

  const PONS_REFERENCE_POOL =
    "0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA";

  const ACTIVE_START_BLOCK = 8991118;
  const LEGACY_START_BLOCK = 8600612;

  const TOKEN_LOOKBACK_BLOCKS = 500000;
  const LOG_CHUNK_SIZE = 50000;
  const MAX_TOKENS = 100;

  const TOKEN_LAUNCHED_TOPIC =
    "0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a";

  const SWAP_TOPIC =
    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

  function normalizeAddress(value) {
    if (!value) return null;
    const str = String(value).trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(str)) return null;
    return str;
  }

  function isAddress(value) {
    return Boolean(normalizeAddress(value));
  }

  function pad32(value) {
    return String(value).replace(/^0x/, "").padStart(64, "0");
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

  function encodeAddress(address) {
    const normalized = normalizeAddress(address);
    if (!normalized) throw new Error("Invalid address");
    return pad32(normalized);
  }

  function encodeUint(value) {
    return BigInt(value).toString(16).padStart(64, "0");
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  let rpcId = 1;

  async function rpc(method, params = []) {
    const id = rpcId++;

    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params
      })
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

  async function getBlockNumber() {
    const result = await rpc("eth_blockNumber");
    return Number(BigInt(result));
  }

  async function ethCall(to, data, blockTag = "latest") {
    return rpc("eth_call", [
      { to, data },
      blockTag
    ]);
  }

  const SELECTOR = {
    name: "06fdde03",
    symbol: "95d89b41",
    decimals: "313ce567",
    totalSupply: "18160ddd",

    /*
     * These metadata selectors are kept isolated here so the
     * adapter fails safely if a token does not expose them.
     */
    logo: "7e4f6f8a",
    description: "7284e416",
    liquidityPool: "7f7c4b7f",
    socials: "a2d6d6f7"
  };

  async function readString(token, selector) {
    try {
      const data = await ethCall(token, "0x" + selector);
      return decodeDynamicString(data);
    } catch {
      return "";
    }
  }

  function decodeDynamicString(data) {
    if (!data || data === "0x") return "";

    const clean = String(data).replace(/^0x/, "");

    try {
      if (clean.length < 128) return "";

      const offset =
        Number(BigInt("0x" + clean.slice(0, 64))) * 2;

      const length =
        Number(
          BigInt(
            "0x" + clean.slice(offset, offset + 64)
          )
        );

      const start = offset + 64;

      const bytes =
        clean.slice(start, start + length * 2);

      const byteArray = [];

      for (let i = 0; i < bytes.length; i += 2) {
        byteArray.push(parseInt(bytes.slice(i, i + 2), 16));
      }

      return new TextDecoder().decode(
        new Uint8Array(byteArray)
      );
    } catch {
      return "";
    }
  }

  async function readUint(token, selector) {
    try {
      const data = await ethCall(token, "0x" + selector);
      return decodeUint(data, 0);
    } catch {
      return 0n;
    }
  }

  async function readAddress(token, selector) {
    try {
      const data = await ethCall(token, "0x" + selector);
      return decodeAddress(data, 0);
    } catch {
      return null;
    }
  }

  async function getSocials(token) {
    try {
      const data = await ethCall(
        token,
        "0x" + SELECTOR.socials
      );

      if (!data || data === "0x") {
        return {
          twitter: "",
          telegram: "",
          discord: "",
          website: "",
          farcaster: ""
        };
      }

      const clean = data.replace(/^0x/, "");
      const values = [];

      for (let i = 0; i < 5; i++) {
        const offsetHex =
          clean.slice(i * 64, i * 64 + 64);

        if (!offsetHex) {
          values.push("");
          continue;
        }

        const offset =
          Number(BigInt("0x" + offsetHex)) * 2;

        if (
          !Number.isFinite(offset) ||
          offset < 0 ||
          offset + 64 > clean.length
        ) {
          values.push("");
          continue;
        }

        const length =
          Number(
            BigInt(
              "0x" +
              clean.slice(offset, offset + 64)
            )
          );

        const start = offset + 64;

        const bytes =
          clean.slice(
            start,
            start + length * 2
          );

        const byteArray = [];

        for (let j = 0; j < bytes.length; j += 2) {
          byteArray.push(
            parseInt(bytes.slice(j, j + 2), 16)
          );
        }

        values.push(
          new TextDecoder().decode(
            new Uint8Array(byteArray)
          )
        );
      }

      return {
        twitter: values[0] || "",
        telegram: values[1] || "",
        discord: values[2] || "",
        website: values[3] || "",
        farcaster: values[4] || ""
      };
    } catch {
      return {
        twitter: "",
        telegram: "",
        discord: "",
        website: "",
        farcaster: ""
      };
    }
  }

  async function getTokenData(tokenAddress) {
    const token = normalizeAddress(tokenAddress);

    if (!token) {
      throw new Error("Invalid token address");
    }

    const [
      name,
      symbol,
      decimals,
      totalSupply,
      logo,
      description,
      pool,
      socials
    ] = await Promise.all([
      readString(token, SELECTOR.name),
      readString(token, SELECTOR.symbol),
      readUint(token, SELECTOR.decimals),
      readUint(token, SELECTOR.totalSupply),
      readString(token, SELECTOR.logo),
      readString(token, SELECTOR.description),
      readAddress(token, SELECTOR.liquidityPool),
      getSocials(token)
    ]);

    return {
      tokenAddress: token,
      tokenName: name || token,
      tokenSymbol: symbol || "",
      decimals: Number(decimals || 18n),
      totalSupply: totalSupply.toString(),

      logo: logo || "",
      tokenImage: logo || "",
      image: logo || "",

      description: description || "",

      poolAddress: pool || null,
      liquidityPool: pool || null,

      pairToken: WETH,
      pairSymbol: "ETH",
      pairDecimals: 18,
      isNativePair: true,
      poolFee: 10000,

      twitter: socials.twitter,
      telegram: socials.telegram,
      discord: socials.discord,
      website: socials.website,
      farcaster: socials.farcaster
    };
  }

  function decodeTokenLaunched(log) {
    try {
      const topics = log.topics || [];

      if (topics.length < 4) return null;

      const token =
        "0x" + topics[1].slice(-40);

      const deployer =
        "0x" + topics[2].slice(-40);

      const dexFactory =
        "0x" + topics[3].slice(-40);

      const data =
        String(log.data || "").replace(/^0x/, "");

      const pairToken =
        decodeAddress("0x" + data, 0);

      const pool =
        decodeAddress("0x" + data, 1);

      const dexId =
        decodeUint("0x" + data, 2);

      const launchConfigId =
        decodeUint("0x" + data, 3);

      const positionId =
        decodeUint("0x" + data, 4);

      const restrictionsEndBlock =
        decodeUint("0x" + data, 5);

      const initialBuyAmount =
        decodeUint("0x" + data, 6);

      return {
        token: normalizeAddress(token),
        deployer: normalizeAddress(deployer),
        dexFactory: normalizeAddress(dexFactory),
        pairToken: normalizeAddress(pairToken),
        pool: normalizeAddress(pool),

        dexId: dexId.toString(),
        launchConfigId: launchConfigId.toString(),
        positionId: positionId.toString(),
        restrictionsEndBlock:
          restrictionsEndBlock.toString(),
        initialBuyAmount:
          initialBuyAmount.toString(),

        blockNumber:
          log.blockNumber
            ? Number(BigInt(log.blockNumber))
            : null,

        transactionHash:
          log.transactionHash || null
      };
    } catch (error) {
      console.warn(
        "[Ponsly] Failed to decode TokenLaunched:",
        error
      );
      return null;
    }
  }

  async function getLogsChunk(
    address,
    fromBlock,
    toBlock
  ) {
    return rpc("eth_getLogs", [{
      address,
      fromBlock:
        "0x" + Number(fromBlock).toString(16),
      toBlock:
        "0x" + Number(toBlock).toString(16),
      topics: [TOKEN_LAUNCHED_TOPIC]
    }]);
  }

  async function scanLogs(
    address,
    startBlock,
    endBlock
  ) {
    const logs = [];

    let from = Number(startBlock);
    const end = Number(endBlock);

    while (from <= end) {
      const to =
        Math.min(
          from + LOG_CHUNK_SIZE - 1,
          end
        );

      try {
        const chunk =
          await getLogsChunk(
            address,
            from,
            to
          );

        if (Array.isArray(chunk)) {
          logs.push(...chunk);
        }
      } catch (error) {
        console.warn(
          "[Ponsly] Log chunk failed:",
          from,
          to,
          error
        );
      }

      from = to + 1;
      await sleep(50);
    }

    return logs;
  }

  async function getTokens(options = {}) {
    const max =
      Number(
        options.limit || MAX_TOKENS
      );

    /*
     * PONS is always returned first.
     * This prevents the index from becoming empty
     * when RPC discovery temporarily fails.
     */

    const ponsRow = {
      tokenAddress:
        PONS_REFERENCE_TOKEN,

      tokenName:
        "PONS",

      tokenSymbol:
        "PONS",

      tokenImage:
        "",

      image:
        "",

      marketCap:
        null,

      progress:
        null,

      phase:
        "graduated",

      poolAddress:
        PONS_REFERENCE_POOL,

      liquidityPool:
        PONS_REFERENCE_POOL,

      pairToken:
        WETH,

      pairSymbol:
        "ETH",

      pairDecimals:
        18,

      isNativePair:
        true,

      poolFee:
        10000,

      trending:
        true,

      reference:
        true
    };

    const unique = [ponsRow];

    /*
     * SAFETY NET: whatever happens below (CORS-blocked RPC,
     * unexpected network errors, anything not already caught
     * by an inner try/catch), this outer try/catch guarantees
     * getTokens() never rejects — it always resolves with at
     * least the PONS reference row so the UI never shows a
     * hard "Token data unavailable" error.
     */
    try {

    const seen =
      new Set([
        PONS_REFERENCE_TOKEN.toLowerCase()
      ]);

    let head;

    try {
      head =
        await getBlockNumber();
    } catch (error) {
      console.error(
        "[Ponsly] RPC unavailable:",
        error
      );

      return unique.slice(0, max);
    }

    const lookback =
      Number(
        options.lookbackBlocks ||
        TOKEN_LOOKBACK_BLOCKS
      );

    const start =
      Math.max(
        0,
        head - lookback
      );

    let activeLogs = [];
    let legacyLogs = [];

    try {
      activeLogs =
        await scanLogs(
          ACTIVE_FACTORY,
          Math.max(
            ACTIVE_START_BLOCK,
            start
          ),
          head
        );
    } catch (error) {
      console.error(
        "[Ponsly] Active factory scan failed:",
        error
      );
    }

    try {
      legacyLogs =
        await scanLogs(
          LEGACY_FACTORY,
          Math.max(
            LEGACY_START_BLOCK,
            start
          ),
          head
        );
    } catch (error) {
      console.error(
        "[Ponsly] Legacy factory scan failed:",
        error
      );
    }

    const launches =
      [
        ...activeLogs,
        ...legacyLogs
      ]
      .map(decodeTokenLaunched)
      .filter(Boolean)
      .sort(
        (a, b) =>
          Number(b.blockNumber || 0) -
          Number(a.blockNumber || 0)
      );

    for (const launch of launches) {
      const token =
        normalizeAddress(launch.token);

      if (!token) continue;

      const key =
        token.toLowerCase();

      if (seen.has(key)) continue;

      seen.add(key);

      unique.push({
        ...launch,

        tokenAddress:
          token,

        poolAddress:
          launch.pool || null,

        liquidityPool:
          launch.pool || null,

        pairToken:
          launch.pairToken || WETH,

        tokenName:
          token,

        tokenSymbol:
          "",

        tokenImage:
          "",

        image:
          "",

        marketCap:
          null,

        progress:
          null,

        phase:
          "launched",

        trending:
          false
      });

      if (unique.length >= max) {
        break;
      }
    }

    const enriched =
      await Promise.all(
        unique
          .slice(0, max)
          .map(async row => {
            try {
              const data =
                await getTokenData(
                  row.tokenAddress
                );

              return {
                ...row,
                ...data,

                tokenImage:
                  data.logo ||
                  row.tokenImage ||
                  "",

                image:
                  data.logo ||
                  row.image ||
                  "",

                launchBlock:
                  row.blockNumber ??
                  row.launchBlock ??
                  null,

                transactionHash:
                  row.transactionHash ??
                  null,

                trending:
                  Boolean(row.trending)
              };
            } catch (error) {
              console.warn(
                "[Ponsly] Metadata failed:",
                row.tokenAddress,
                error
              );

              return row;
            }
          })
      );

    return enriched.filter(Boolean);

    } catch (error) {
      console.error(
        "[Ponsly] getTokens failed unexpectedly — falling back to PONS reference row:",
        error
      );
      return unique.slice(0, max);
    }
  }

  async function getQuote(options = {}) {
    const token =
      normalizeAddress(
        options.tokenAddress ||
        options.token
      );

    if (!token) return null;

    const amountIn =
      options.amountIn != null
        ? BigInt(options.amountIn)
        : null;

    const zeroForOne =
      options.zeroForOne !== false;

    if (
      amountIn === null ||
      amountIn <= 0n
    ) {
      return null;
    }

    /*
     * Read-only Quoter V2 call.
     */

    try {
      const selector = "c6a5026a";

      const data =
        "0x" +
        selector +
        encodeAddress(
          zeroForOne ? WETH : token
        ) +
        encodeAddress(
          zeroForOne ? token : WETH
        ) +
        encodeUint(amountIn) +
        encodeUint(10000) +
        encodeUint(0);

      const result =
        await ethCall(
          QUOTER_V2,
          data
        );

      if (!result || result === "0x") {
        return null;
      }

      const amountOut =
        decodeUint(result, 0);

      return {
        tokenIn:
          zeroForOne ? WETH : token,

        tokenOut:
          zeroForOne ? token : WETH,

        amountIn:
          amountIn.toString(),

        amountOut:
          amountOut.toString(),

        fee:
          10000,

        raw:
          result
      };
    } catch (error) {
      console.warn(
        "[Ponsly] Quote failed:",
        error
      );

      return null;
    }
  }

  function getExplorerTokenUrl(token) {
    const address =
      normalizeAddress(token);

    if (!address) return "";

    return (
      EXPLORER_URL +
      "/address/" +
      address
    );
  }

  function getExplorerTxUrl(tx) {
    if (!tx) return "";

    return (
      EXPLORER_URL +
      "/tx/" +
      tx
    );
  }

  function getExplorerPoolUrl(pool) {
    const address =
      normalizeAddress(pool);

    if (!address) return "";

    return (
      EXPLORER_URL +
      "/address/" +
      address
    );
  }

  window.PonslyPons = {
    chainId: CHAIN_ID,
    chainName: "Robinhood Chain",
    rpc: RPC_URL,
    explorer: EXPLORER_URL,

    weth: WETH,
    activeFactory: ACTIVE_FACTORY,
    legacyFactory: LEGACY_FACTORY,
    v3Factory: V3_FACTORY,
    quoterV2: QUOTER_V2,
    swapRouter: SWAP_ROUTER,
    positionManager: POSITION_MANAGER,

    referenceToken: PONS_REFERENCE_TOKEN,
    referencePool: PONS_REFERENCE_POOL,

    getBlockNumber,
    getTokenData,
    getTokens,
    getQuote,

    getExplorerTokenUrl,
    getExplorerTxUrl,
    getExplorerPoolUrl,

    normalizeAddress,
    isAddress,

    isReady: true
  };

  console.log(
    "[Ponsly] pons.js loaded — Robinhood Chain 4663"
  );

})();
