/* =========================================================
   PONSLY — TOKEN DATA ADAPTER (Pons V2)
   File: token.js
   Chain: Robinhood Chain
   Chain ID: 4663

   READ-ONLY ADAPTER.

   Rewritten from the old pons.js (Pons V1 onchain adapter).
   Differences from that file:
     - No more special-casing of a single "reference" token (the
       real PONS coin). This adapter treats every token the same.
     - discoverLaunchedTokens() now scans the Pons V2 factory
       (FACTORY_V2) instead of the V1 factories — see the warning
       on TOPIC_TOKEN_LAUNCHED_V2 below, this part is unverified.
     - getLaunchedToken() (V2 factory struct reader) is ported in
       from pons-v2-indexer.js so token.js can report a token's
       V2 phase/curve/graduation status without needing that file.
     - KNOWN_TOKENS is a small static registry for the 4 tokens
       Ponsly currently features. It exists so the page has a
       reliable token list even before discoverLaunchedTokens()
       has been verified against a real V2 launch — fill in each
       dextoolsPairId once you have it from dextools.io.
   ========================================================= */

(function () {
  "use strict";

  const CHAIN_ID = 4663;

  const RPC_URL =
    /*
     * rpc.mainnet.chain.robinhood.com does not send CORS headers,
     * so calling it directly from a browser fails with "Failed to
     * fetch". This points at the Ponsly RPC proxy (Cloudflare
     * Worker) instead, which forwards to the real RPC
     * server-to-server and adds CORS headers back.
     */
    "https://ponsly-rpc-proxy.rifinzsmith477.workers.dev";

  const EXPLORER_URL =
    "https://robinhoodchain.blockscout.com";

  const WETH =
    "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

  const QUOTER_V2 =
    "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";

  const SWAP_ROUTER =
    "0xCaf681a66D020601342297493863E78C959E5cb2";

  const POSITION_MANAGER =
    "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3";

  // ------------------------------------------------------------
  // Pons V2 factory — from docs.ponsfamily.com/v2 "Contracts"
  // section (same source pons-v2-indexer.js used). Independently
  // cross-checked against a third-party pons-launcher repo, which
  // found this exact address by scanning the chain directly for
  // TokenLaunched logs (that repo explicitly flags the docs page
  // itself as unreliable for addresses — this one checks out because
  // two independent sources landed on it, not because the docs page
  // said so).
  // ------------------------------------------------------------
  const FACTORY_V2 = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
  const MEME_HOOK_V2 = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";

  const SELECTOR_GET_LAUNCHED_TOKEN = "0x3cf28b5a"; // getLaunchedToken(address)

  // Pons V2 approved quote assets are owner-managed. There is no enumerable
  // mapping getter, so the live list is reconstructed from approval events
  // and then verified against approvedPairTokens(address). Native ETH is
  // always represented by address(0).
  const TOPIC_PAIR_TOKEN_APPROVAL_UPDATED =
    "0x060d1992d069dc524985f328329aae36102a017c59733c5c91fc0691ee0703b6";
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
  const SELECTOR_APPROVED_PAIR_TOKENS = "0x" + "b7d2a4c7"; // approvedPairTokens(address)

  /*
   * IMPORTANT — UNVERIFIED, CHECK BEFORE TRUSTING:
   * This topic0 is copied from pons-v2-indexer.js, which sourced it
   * from docs.ponsfamily.com/v2's "Events to index" section — but
   * that file only ever *defined* this constant, it never actually
   * decoded a TokenLaunched(V2) log with it (no discovery function
   * existed for V2 before this file). The decode below assumes the
   * token address is the log's first indexed topic (topics[1]),
   * matching the V1 event's layout and the convention used by
   * getLaunchedToken(address) itself — but this has NOT been
   * confirmed against a real V2 launch log yet.
   *
   * Before relying on discoverLaunchedTokens() in production: fire
   * it once, take a token address it returns, and cross-check that
   * address by calling getLaunchedToken() directly (below) — if
   * that returns a real struct (exists: true), the decode is
   * correct. If discovery ever returns nothing or garbage
   * addresses, this topic/decode assumption is the first thing to
   * re-check against docs.ponsfamily.com/v2.
   */
  const TOPIC_TOKEN_LAUNCHED_V2 =
    "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";

  /*
   * No confirmed deploy block for FACTORY_V2 is on hand, so this
   * just looks back a fixed window like the old V1 scanner did.
   * If you have the factory's actual deploy block (from its
   * contract-creation tx on the explorer), set it here instead —
   * it makes every discovery scan faster and cheaper.
   */
  const FACTORY_V2_START_BLOCK = null; // TODO: fill in if known
  const TOKEN_LOOKBACK_BLOCKS = 500000;
  const LOG_CHUNK_SIZE = 50000;
  const MAX_TOKENS = 100;

  // ------------------------------------------------------------
  // The 4 tokens Ponsly currently features.
  //
  // ZZZ's dextoolsPairId below was verified against DexTools' own
  // data for this exact address (token address matched byte-for-
  // byte) — safe to trust.
  //
  // Orbi.so, Bundle cat, and Ubik are still null: they weren't
  // reliably findable through search (Orbi.so — likely traded as
  // "Orbio.so"/ORBIO — turned up a probable WETH pool at
  // 0x58e3537ea1210f4bf414d94b55db98cc1a2ff5b7 on dexscreener, but
  // that wasn't cross-checked against the token address the way ZZZ
  // was, so don't trust it blindly; Bundle cat and Ubik didn't turn
  // up at all). For these 3, open dextools.io, search the token
  // address, open the pair page, use its embed/share button, and
  // copy the pair ID out of the generated iframe URL.
  // ------------------------------------------------------------
  const KNOWN_TOKENS = [
    { address: "0x7dbf38976f6D3b9c529e7D9484A71898B409eE6a", label: "ZZZ", dextoolsPairId: "0xf398e8f73f8b5067a978b1306c963e0c2224b2ada11b71d294d756106d02ae5d" },
    { address: "0xAa07A0e9209e16aC99708C3EC70159c6eF3128A3", label: "Orbi.so", dextoolsPairId: null },
    { address: "0x07EBB29a38Fbcb41563817e5E19f2ceC619C90D2", label: "Bundle cat", dextoolsPairId: null },
    { address: "0x812486EAea648819853F8E372dc9f1516C7868Bd", label: "Ubik", dextoolsPairId: null }
  ];

  const DEXTOOLS_PAIR_IDS = {};
  for (const t of KNOWN_TOKENS) {
    if (t.dextoolsPairId) DEXTOOLS_PAIR_IDS[t.address.toLowerCase()] = t.dextoolsPairId;
  }

  // ------------------------------------------------------------
  // DEXTools pair resolver
  // ------------------------------------------------------------
  // DEXTools' widget needs the actual pair/pool ID, not merely the
  // token contract address. For graduated Pons V2 launches, resolve
  // the matching pool from DexScreener's Robinhood Chain pair index.
  // The returned pairAddress is passed unchanged to the DEXTools
  // widget. This removes the old "ZZZ works, 3 tokens are null"
  // limitation and also works for future tokens.
  //
  // Priority:
  //   1. Existing verified static mapping (ZZZ)
  //   2. Pair whose quote token matches the Pons V2 launch pairToken
  //   3. Highest-liquidity Robinhood pair for the token
  // ------------------------------------------------------------
  async function resolveDexToolsPairId(tokenAddress, launch) {
    const normalized = normalizeAddress(tokenAddress);
    if (!normalized) return null;

    const staticPair = DEXTOOLS_PAIR_IDS[normalized.toLowerCase()];
    if (staticPair) return staticPair;

    try {
      const url =
        "https://api.dexscreener.com/token-pairs/v1/robinhood/" +
        encodeURIComponent(normalized);

      const response = await fetch(url, {
        method: "GET",
        headers: { "Accept": "application/json" },
        cache: "no-store"
      });

      if (!response.ok) {
        console.warn("[Ponsly] DexScreener pair lookup failed:", response.status);
        return null;
      }

      const data = await response.json();
      const pairs = Array.isArray(data) ? data : [];

      if (!pairs.length) return null;

      const tokenLc = normalized.toLowerCase();
      const quoteLc = launch && launch.pairToken
        ? launch.pairToken.toLowerCase()
        : null;

      const valid = pairs.filter(p => {
        const pairAddress = typeof p.pairAddress === "string" ? p.pairAddress : "";
        const base = p.baseToken && typeof p.baseToken.address === "string"
          ? p.baseToken.address.toLowerCase()
          : "";
        const quote = p.quoteToken && typeof p.quoteToken.address === "string"
          ? p.quoteToken.address.toLowerCase()
          : "";

        return Boolean(pairAddress) && (base === tokenLc || quote === tokenLc);
      });

      if (!valid.length) return null;

      // Prefer the exact Pons V2 quote asset.
      if (quoteLc) {
        const matchingQuote = valid.filter(p => {
          const base = p.baseToken && typeof p.baseToken.address === "string"
            ? p.baseToken.address.toLowerCase()
            : "";
          const quote = p.quoteToken && typeof p.quoteToken.address === "string"
            ? p.quoteToken.address.toLowerCase()
            : "";
          return base === quoteLc || quote === quoteLc;
        });

        if (matchingQuote.length) {
          matchingQuote.sort(
            (a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0)
          );
          return matchingQuote[0].pairAddress;
        }
      }

      // Fallback: use the most liquid pair indexed for this token.
      valid.sort(
        (a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0)
      );

      return valid[0].pairAddress || null;
    } catch (error) {
      console.warn("[Ponsly] Dynamic DEXTools pair lookup failed:", error);
      return null;
    }
  }

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
    const w = typeof index === "number" ? word(data, index) : data;
    if (!w || w.length < 40) return null;
    return "0x" + w.slice(-40);
  }

  function decodeUint(data, index) {
    const w = typeof index === "number" ? word(data, index) : data;
    if (!w) return 0n;
    try {
      return BigInt("0x" + w);
    } catch {
      return 0n;
    }
  }

  function decodeInt(hexWord) {
    // ABI encoders sign-extend signed integers to a full 32-byte
    // word, so a straight two's-complement read over 256 bits is
    // correct regardless of the source type's declared width.
    const raw = decodeUint(hexWord);
    const TWO_255 = 1n << 255n;
    const TWO_256 = 1n << 256n;
    return raw >= TWO_255 ? raw - TWO_256 : raw;
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    });

    if (!response.ok) {
      throw new Error(`RPC HTTP ${response.status}`);
    }

    const json = await response.json();

    if (json.error) {
      throw new Error(json.error.message || `RPC error ${json.error.code || ""}`);
    }

    return json.result;
  }

  async function getBlockNumber() {
    const result = await rpc("eth_blockNumber");
    return Number(BigInt(result));
  }

  async function ethCall(to, data, blockTag = "latest") {
    return rpc("eth_call", [{ to, data }, blockTag]);
  }

  const SELECTOR = {
    name: "06fdde03",
    symbol: "95d89b41",
    decimals: "313ce567",
    totalSupply: "18160ddd",

    // Custom selectors kept isolated so the adapter fails safely if
    // a token does not expose them.
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

      const offset = Number(BigInt("0x" + clean.slice(0, 64))) * 2;
      const length = Number(BigInt("0x" + clean.slice(offset, offset + 64)));
      const start = offset + 64;
      const bytes = clean.slice(start, start + length * 2);

      const byteArray = [];
      for (let i = 0; i < bytes.length; i += 2) {
        byteArray.push(parseInt(bytes.slice(i, i + 2), 16));
      }

      return new TextDecoder().decode(new Uint8Array(byteArray));
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
      const data = await ethCall(token, "0x" + SELECTOR.socials);

      if (!data || data === "0x") {
        return { twitter: "", telegram: "", discord: "", website: "", farcaster: "" };
      }

      const clean = data.replace(/^0x/, "");
      const values = [];

      for (let i = 0; i < 5; i++) {
        const offsetHex = clean.slice(i * 64, i * 64 + 64);
        if (!offsetHex) { values.push(""); continue; }

        const offset = Number(BigInt("0x" + offsetHex)) * 2;
        if (!Number.isFinite(offset) || offset < 0 || offset + 64 > clean.length) {
          values.push("");
          continue;
        }

        const length = Number(BigInt("0x" + clean.slice(offset, offset + 64)));
        const start = offset + 64;
        const bytes = clean.slice(start, start + length * 2);

        const byteArray = [];
        for (let j = 0; j < bytes.length; j += 2) {
          byteArray.push(parseInt(bytes.slice(j, j + 2), 16));
        }

        values.push(new TextDecoder().decode(new Uint8Array(byteArray)));
      }

      return {
        twitter: values[0] || "",
        telegram: values[1] || "",
        discord: values[2] || "",
        website: values[3] || "",
        farcaster: values[4] || ""
      };
    } catch {
      return { twitter: "", telegram: "", discord: "", website: "", farcaster: "" };
    }
  }

  // ------------------------------------------------------------
  // Pons V2 factory read — ported from pons-v2-indexer.js. Every
  // field of the LaunchedToken struct is a value type, so the
  // return data is just 15 consecutive 32-byte words in
  // struct-declaration order (docs.ponsfamily.com/v2 "Reading
  // state").
  // ------------------------------------------------------------
  async function getLaunchedToken(tokenAddress) {
    const token = normalizeAddress(tokenAddress);
    if (!token) return null;

    const data = "0x" + SELECTOR_GET_LAUNCHED_TOKEN.replace(/^0x/, "") + pad32(token);

    let result;
    try {
      result = await ethCall(FACTORY_V2, data);
    } catch (e) {
      console.warn("[Ponsly] getLaunchedToken call failed:", token, e);
      return null;
    }

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

  // ------------------------------------------------------------
  // Token metadata (generic — works for any token, not just one
  // reference coin). Also pulls in V2 launch state when the token
  // was actually launched via the Pons V2 factory.
  // ------------------------------------------------------------
  async function getTokenData(tokenAddress) {
    const token = normalizeAddress(tokenAddress);
    if (!token) throw new Error("Invalid token address");

    const [name, symbol, decimals, totalSupply, logo, description, customPool, socials, launch] =
      await Promise.all([
        readString(token, SELECTOR.name),
        readString(token, SELECTOR.symbol),
        readUint(token, SELECTOR.decimals),
        readUint(token, SELECTOR.totalSupply),
        readString(token, SELECTOR.logo),
        readString(token, SELECTOR.description),
        readAddress(token, SELECTOR.liquidityPool),
        getSocials(token),
        getLaunchedToken(token)
      ]);

    // Prefer the token contract's own liquidityPool() reading; fall
    // back to the V2 factory's curve address (pre-graduation AMM)
    // when the custom selector comes back empty. Never fabricated.
    const resolvedPool = customPool || (launch ? launch.curve : null);

    // Resolve the DEXTools widget pair after launch state is known.
    // ZZZ uses its verified static ID; other V2 tokens are resolved
    // automatically from their Robinhood Chain pair index.
    const dextoolsPairId = await resolveDexToolsPairId(token, launch);

    // IMPORTANT: Pons V2 can use custom pair assets. Do not assume
    // ETH/WETH. Read the actual pair token metadata so Orbi.so can
    // correctly report NVDA and Ubik can correctly report GLD.
    let pairTokenName = "";
    let pairTokenSymbol = "";
    let pairDecimals = 18;

    if (launch && launch.pairToken) {
      try {
        const [pairName, pairSymbol, pairDecimalsRaw] = await Promise.all([
          readString(launch.pairToken, SELECTOR.name),
          readString(launch.pairToken, SELECTOR.symbol),
          readUint(launch.pairToken, SELECTOR.decimals)
        ]);

        pairTokenName = pairName || "";
        pairTokenSymbol = pairSymbol || "";
        pairDecimals = Number(pairDecimalsRaw || 18n);
      } catch {
        // Keep the on-chain pair address even if optional metadata fails.
      }
    }

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

      poolAddress: resolvedPool,
      liquidityPool: resolvedPool,
      dextoolsPairId,

      pairToken: (launch && launch.pairToken) || WETH,
      pairTokenName: pairTokenName || "",
      pairSymbol: pairTokenSymbol || "",
      pairDecimals,
      isNativePair: Boolean(
        launch &&
        launch.pairToken &&
        launch.pairToken.toLowerCase() === WETH.toLowerCase()
      ),
      poolFee: (launch && launch.poolFee) || 10000,

      // V2 launch state — null when the token wasn't launched via
      // the Pons V2 factory (e.g. an arbitrary external token).
      v2Phase: launch ? launch.phase : null,
      v2Curve: launch ? launch.curve : null,
      v2GraduationThreshold: launch ? launch.graduationThreshold.toString() : null,
      v2Deployer: launch ? launch.deployer : null,

      twitter: socials.twitter,
      telegram: socials.telegram,
      discord: socials.discord,
      website: socials.website,
      farcaster: socials.farcaster
    };
  }

  // ------------------------------------------------------------
  // Discovery — scans the Pons V2 factory for TokenLaunched events.
  // See the big warning on TOPIC_TOKEN_LAUNCHED_V2 above: verify
  // this against a real launch before trusting it fully. Never
  // throws — resolves to [] on any failure so it degrades
  // gracefully instead of breaking a page that lists tokens.
  // ------------------------------------------------------------
  function decodeTokenLaunchedV2(log) {
    try {
      const topics = log.topics || [];
      if (topics.length < 2) return null;

      const token = normalizeAddress(decodeAddress(topics[1]));
      if (!token) return null;

      return {
        token,
        blockNumber: log.blockNumber ? Number(BigInt(log.blockNumber)) : null,
        transactionHash: log.transactionHash || null
      };
    } catch (error) {
      console.warn("[Ponsly] Failed to decode TokenLaunched (V2):", error);
      return null;
    }
  }

  async function scanLogs(address, startBlock, endBlock, topics) {
    const logs = [];
    let from = Number(startBlock);
    const end = Number(endBlock);

    while (from <= end) {
      const to = Math.min(from + LOG_CHUNK_SIZE - 1, end);

      try {
        const chunk = await rpc("eth_getLogs", [{
          address,
          fromBlock: "0x" + Number(from).toString(16),
          toBlock: "0x" + Number(to).toString(16),
          topics
        }]);
        if (Array.isArray(chunk)) logs.push(...chunk);
      } catch (error) {
        console.warn("[Ponsly] Log chunk failed:", from, to, error);
      }

      from = to + 1;
      await sleep(50);
    }

    return logs;
  }

  async function discoverLaunchedTokens(options = {}) {
    const max = Number(options.limit || MAX_TOKENS);

    try {
      const seen = new Set(KNOWN_TOKENS.map(t => t.address.toLowerCase()));
      const unique = [];

      let head;
      try {
        head = await getBlockNumber();
      } catch (error) {
        console.error("[Ponsly] RPC unavailable:", error);
        return [];
      }

      const lookback = Number(options.lookbackBlocks || TOKEN_LOOKBACK_BLOCKS);
      const start = Math.max(
        FACTORY_V2_START_BLOCK || 0,
        head - lookback
      );

      let logs = [];
      try {
        logs = await scanLogs(FACTORY_V2, start, head, [TOPIC_TOKEN_LAUNCHED_V2]);
      } catch (error) {
        console.error("[Ponsly] Factory V2 scan failed:", error);
      }

      const launches = logs
        .map(decodeTokenLaunchedV2)
        .filter(Boolean)
        .sort((a, b) => Number(b.blockNumber || 0) - Number(a.blockNumber || 0));

      for (const launch of launches) {
        const key = launch.token.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        unique.push({
          tokenAddress: launch.token,
          launchBlock: launch.blockNumber,
          transactionHash: launch.transactionHash,
          tokenName: launch.token,
          tokenSymbol: "",
          tokenImage: "",
          image: ""
        });

        if (unique.length >= max) break;
      }

      const enriched = await Promise.all(
        unique.map(async row => {
          try {
            const data = await getTokenData(row.tokenAddress);
            return { ...row, ...data };
          } catch (error) {
            console.warn("[Ponsly] Metadata failed:", row.tokenAddress, error);
            return row;
          }
        })
      );

      return enriched.filter(Boolean);
    } catch (error) {
      console.error("[Ponsly] discoverLaunchedTokens failed unexpectedly:", error);
      return [];
    }
  }

  // ------------------------------------------------------------
  // KNOWN_TOKENS as fully-enriched rows — a reliable base list
  // that doesn't depend on discovery being correct.
  // ------------------------------------------------------------
  async function getKnownTokens() {
    const rows = await Promise.all(
      KNOWN_TOKENS.map(async t => {
        try {
          const data = await getTokenData(t.address);
          return { ...data, label: t.label };
        } catch (error) {
          console.warn("[Ponsly] getKnownTokens failed for", t.address, error);
          return { tokenAddress: t.address, tokenName: t.label, tokenSymbol: "", label: t.label };
        }
      })
    );
    return rows;
  }

  /*
   * Combined call: known 4 tokens first (always shown, even if
   * discovery is having a bad day), then whatever discovery finds
   * beyond those.
   */
  async function getTokens(options = {}) {
    const max = Number(options.limit || MAX_TOKENS);

    const [known, discovered] = await Promise.all([
      getKnownTokens(),
      discoverLaunchedTokens(options)
    ]);

    return [...known, ...discovered].slice(0, max);
  }

  async function getQuote(options = {}) {
    const token = normalizeAddress(options.tokenAddress || options.token);
    if (!token) return null;

    const amountIn = options.amountIn != null ? BigInt(options.amountIn) : null;
    const zeroForOne = options.zeroForOne !== false;

    if (amountIn === null || amountIn <= 0n) return null;

    try {
      const selector = "c6a5026a";

      const data =
        "0x" + selector +
        encodeAddress(zeroForOne ? WETH : token) +
        encodeAddress(zeroForOne ? token : WETH) +
        encodeUint(amountIn) +
        encodeUint(10000) +
        encodeUint(0);

      const result = await ethCall(QUOTER_V2, data);
      if (!result || result === "0x") return null;

      const amountOut = decodeUint(result, 0);

      return {
        tokenIn: zeroForOne ? WETH : token,
        tokenOut: zeroForOne ? token : WETH,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        fee: 10000,
        raw: result
      };
    } catch (error) {
      console.warn("[Ponsly] Quote failed:", error);
      return null;
    }
  }

  function getExplorerTokenUrl(token) {
    const address = normalizeAddress(token);
    if (!address) return "";
    return EXPLORER_URL + "/address/" + address;
  }

  function getExplorerTxUrl(tx) {
    if (!tx) return "";
    return EXPLORER_URL + "/tx/" + tx;
  }

  function getExplorerPoolUrl(pool) {
    const address = normalizeAddress(pool);
    if (!address) return "";
    return EXPLORER_URL + "/address/" + address;
  }

  // ------------------------------------------------------------
  // Approved V2 quote assets
  // ------------------------------------------------------------
  const APPROVED_PAIR_SCAN_BLOCKS = 5000000;

  const PAIR_SNAPSHOT = [
    // Native ETH is always a valid V2 quote asset.
    { address: ZERO_ADDRESS, symbol: "ETH", name: "Ether", decimals: 18, isNative: true },
    // Known current V2 quote assets from the public Pons/Robinhood index.
    { address: "0x5fc5360d0400a0fd4f2af552add042d716f1d168", symbol: "USDG", decimals: 6 },
    { address: "0xcec185eb182c47d1ba1efc84e6959e18cd620be4", symbol: "cbBTC", decimals: 8 },
    { address: "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9", symbol: "AAPL", decimals: 18 },
    { address: "0x86923f96303d656e4aa86d9d42d1e57ad2023fdc", symbol: "AMD", decimals: 18 },
    { address: "0x12f190a9f9d7d37a250758b26824b97ce941bf54", symbol: "AMZN", decimals: 18 },
    { address: "0x48e39e56acdba37b09020c0b734a613c9a2f100a", symbol: "BB", decimals: 18 },
    { address: "0x6330d8c3178a418788df01a47479c0ce7ccf450b", symbol: "COIN", decimals: 18 },
    { address: "0x4ea005168d7f09a7a0ba9d1def21a479950e44c2", symbol: "COST", decimals: 18 },
    { address: "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5", symbol: "CRCL", decimals: 18 },
    { address: "0x941ae714ec6d8130c7b75d67160ca08f1e7d11dd", symbol: "DELL", decimals: 18 },
    { address: "0x1d11f0496982706c5e14a514d4e79f2e6bde4516", symbol: "DJT", decimals: 18 },
    { address: "0xc9a981fee1f9dec688bb123ccdecc63d0debfc4e", symbol: "GLD", decimals: 18 },
    { address: "0x1b0e319c6a659f002271b69db8a7df2f911c153e", symbol: "GME", decimals: 18 },
    { address: "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3", symbol: "GOOGL", decimals: 18 },
    { address: "0xccee82fe024c36fa15e1005ede3e9e4787e23d09", symbol: "HIMS", decimals: 18 },
    { address: "0x8005d266423c7ea827372c9c864491e5786600ea", symbol: "LLY", decimals: 18 },
    { address: "0xc0d6457c16cc70d6790dd43521c899c87ce02f35", symbol: "META", decimals: 18 },
    { address: "0xe93237c50d904957cf27e7b1133b510c669c2e74", symbol: "MSFT", decimals: 18 },
    { address: "0xec262a75e413fafd0df80480274532c79d42da09", symbol: "MSTR", decimals: 18 },
    { address: "0xff080c8ce2e5feadaca0da81314ae59d232d4afd", symbol: "MU", decimals: 18 },
    { address: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec", symbol: "NVDA", decimals: 18 },
    { address: "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a", symbol: "PLTR", decimals: 18 },
    { address: "0xd5f3879160bc7c32ebb4dc785f8a4f505888de68", symbol: "QQQ", decimals: 18 },
    { address: "0xf0c4bf4c582cb3836e98394b1d4e7b7281101be8", symbol: "RBLX", decimals: 18 },
    { address: "0x05b37fb53a299a1b874a619e1c4c404d52c36f4c", symbol: "RDDT", decimals: 18 },
    { address: "0x84cab63bc87912e71ad199ff14a0ba45de68fef8", symbol: "SKHY", decimals: 18 },
    { address: "0xb90a19ff0af67f7779aff50a882a9cff42446400", symbol: "SNDK", decimals: 18 },
    { address: "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea", symbol: "SPCX", decimals: 18 },
    { address: "0x117cc2133c37b721f49de2a7a74833232b3b4c0c", symbol: "SPY", decimals: 18 },
    { address: "0x322f0929c4625ed5bad873c95208d54e1c003b2d", symbol: "TSLA", decimals: 18 },
    { address: "0x58ffe4a942d3885baa22d7520691f611ef09e7aa", symbol: "TSM", decimals: 18 },
    { address: "0x5e81213613b6b86eab4c6c50d718d34359459786", symbol: "TTWO", decimals: 18 },
    { address: "0xa30fa36db767ad9ed3f7a60fc79526fb4d56d344", symbol: "USO", decimals: 18 },
    { address: "0x9e7abd3c9139d14e4c86dce0e455aab7a0c2fb3e", symbol: "WYFI", decimals: 18 }
  ];

  function decodeApprovalPairAddress(log) {
    try {
      const topics = log.topics || [];
      if (topics.length < 2) return null;
      return normalizeAddress(decodeAddress(topics[1]));
    } catch { return null; }
  }

  async function getApprovedPairTokens() {
    const candidates = new Map();
    for (const item of PAIR_SNAPSHOT) {
      const a = normalizeAddress(item.address);
      if (a) candidates.set(a.toLowerCase(), { ...item, address: a });
    }

    try {
      const head = await getBlockNumber();
      const start = Math.max(0, Number(head) - APPROVED_PAIR_SCAN_BLOCKS);
      const logs = await scanLogs(FACTORY_V2, start, Number(head), [TOPIC_PAIR_TOKEN_APPROVAL_UPDATED]);
      for (const log of logs) {
        const address = decodeApprovalPairAddress(log);
        if (address) candidates.set(address.toLowerCase(), { address });
      }
    } catch (error) {
      console.warn("[Ponsly] Pair approval history scan failed; using verified snapshot only:", error);
    }

    const assets = [];
    for (const item of candidates.values()) {
      if (item.isNative) {
        assets.push({ ...item, approved: true, symbol: "ETH", name: "Ether", decimals: 18 });
        continue;
      }
      try {
        const approvedRaw = await ethCall(FACTORY_V2, SELECTOR_APPROVED_PAIR_TOKENS + pad32(item.address));
        const approved = decodeUint(approvedRaw, 0) !== 0n;
        if (!approved) continue;
        const [name, symbol, decimals] = await Promise.all([
          readString(item.address, SELECTOR.name),
          readString(item.address, SELECTOR.symbol),
          readUint(item.address, SELECTOR.decimals)
        ]);
        assets.push({
          address: item.address,
          name: name || item.name || symbol || item.symbol || item.address,
          symbol: symbol || item.symbol || item.address.slice(0, 6),
          decimals: Number(decimals || item.decimals || 18n),
          approved: true,
          isNative: false
        });
      } catch {
        // Ignore candidates that are no longer valid/currently approved.
      }
    }

    assets.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const ethIndex = assets.findIndex(a => a.isNative);
    if (ethIndex > 0) assets.unshift(...assets.splice(ethIndex, 1));
    return assets;
  }

  // ============================================================
  // PUBLIC API
  // ============================================================
  window.PonslyToken = {
    chainId: CHAIN_ID,
    chainName: "Robinhood Chain",
    rpc: RPC_URL,
    explorer: EXPLORER_URL,

    weth: WETH,
    factoryV2: FACTORY_V2,
    memeHookV2: MEME_HOOK_V2,
    quoterV2: QUOTER_V2,
    swapRouter: SWAP_ROUTER,
    positionManager: POSITION_MANAGER,

    knownTokens: KNOWN_TOKENS,

    isAddress,
    normalizeAddress,

    getBlockNumber,
    getTokenData,
    getLaunchedToken,
    getKnownTokens,
    discoverLaunchedTokens,
    getTokens,
    getQuote,
    getApprovedPairTokens,

    getExplorerTokenUrl,
    getExplorerTxUrl,
    getExplorerPoolUrl,

    isReady: true
  };

  console.log("[Ponsly] token.js loaded — Robinhood Chain 4663 (Pons V2)");
})();
