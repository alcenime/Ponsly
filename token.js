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

  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  const WETH =
    "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

  // Pons V2 buy-side quote assets are an allowlisted set. The factory
  // itself is the authority; this endpoint is used only to enumerate
  // current candidates, then every address is verified against
  // approvedPairTokens() on the V2 factory before it is returned.
  const PAIR_REGISTRY_URL = "https://nyc.j7tracker.io/token/pons-pairs";

  // Fallback candidates for environments where the registry endpoint is
  // unavailable. These are not treated as approved until the factory
  // approves them onchain.
  const FALLBACK_PAIR_CANDIDATES = [
    ["USDG", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"],
    ["cbBTC", "0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4"],
    ["NVDA", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"],
    ["AAPL", "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9"],
    ["TSLA", "0x322F0929c4625eD5bAd873c95208D54E1c003b2d"],
    ["GOOGL", "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3"],
    ["AMZN", "0x12f190a9F9d7D37a250758b26824B97CE941bF54"],
    ["MSFT", "0xe93237C50D904957Cf27E7B1133b510C669c2e74"],
    ["META", "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35"],
    ["SPCX", "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa"],
    ["TTWO", "0x5e81213613b6B86EaB4c6c50d718d34359459786"],
    ["QQQ", "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68"],
    ["PLTR", "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A"],
    ["GLD", "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e"],
    ["CRCL", "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5"],
    ["COST", "0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2"],
    ["MSTR", "0xec262a75e413fAfD0dF80480274532C79D42da09"],
    ["AMD", "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC"],
    ["SNDK", "0xB90A19fF0Af67f7779afF50A882A9CfF42446400"],
    ["BB", "0x48E39E56aCdbA37b09020C0b734A613C9a2f100A"],
    ["MU", "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD"],
    ["HIMS", "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09"],
    ["RDDT", "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C"],
    ["DJT", "0x1D11f0496982706C5e14A514D4E79F2e6BdE4516"],
    ["GME", "0x1b0E319c6A659F002271B69dB8A7df2F911c153E"],
    ["SPY", "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C"],
    ["COIN", "0x6330D8C3178a418788dF01a47479c0ce7CCF450b"],
    ["NFLX", "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8"],
  ];

  // Small built-in Ethereum mark for native ETH. ERC-20 pair logos are
  // resolved from the pair token itself first, then Blockscout as a fallback.
  const ETH_LOGO_DATA_URI =
    "data:image/svg+xml;charset=UTF-8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<path fill="#8C8C8C" d="M32 4L17 32l15 8 15-8L32 4z"/>' +
      '<path fill="#5F5F5F" d="M32 40l-15-8 15 28 15-28-15 8z"/>' +
      '<path fill="#B0B0B0" d="M32 4v36l15-8L32 4z"/>' +
      '<path fill="#707070" d="M32 40v20l15-28-15 8z"/>' +
      '</svg>'
    );

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
  const SELECTOR_APPROVED_PAIR = "0x9831705e"; // approvedPairTokens(address)
  const TOPIC_PAIR_APPROVAL_UPDATED = "0x060d1992d069dc524985f328329aae36102a017c59733c5c91fc0691ee0703b6";

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

  async function resolveExternalTokenLogo(tokenAddress) {
    const token = normalizeAddress(tokenAddress);
    if (!token || token.toLowerCase() === ZERO_ADDRESS) return "";

    try {
      const response = await fetch(
        EXPLORER_URL + "/api/v2/tokens/" + encodeURIComponent(token),
        {
          method: "GET",
          headers: { "Accept": "application/json" },
          cache: "no-store"
        }
      );

      if (!response.ok) return "";

      const data = await response.json();
      return typeof data.icon_url === "string" ? data.icon_url : "";
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
  async function readApprovedPair(pairToken) {
    try {
      const data = "0x" + SELECTOR_APPROVED_PAIR.replace(/^0x/, "") + pad32(pairToken);
      const result = await ethCall(FACTORY_V2, data);
      return decodeUint((result || "0x0").replace(/^0x/, "").padStart(64, "0")) !== 0n;
    } catch {
      return false;
    }
  }

  async function getPairMetadata(address, fallbackSymbol = "") {
    if (!address || address.toLowerCase() === ZERO_ADDRESS) {
      return { address: ZERO_ADDRESS, symbol: "ETH", name: "Ether", decimals: 18, logo: "", isNative: true };
    }

    const [name, symbol, decimals, logo] = await Promise.all([
      readString(address, SELECTOR.name).catch(() => ""),
      readString(address, SELECTOR.symbol).catch(() => ""),
      readUint(address, SELECTOR.decimals).catch(() => 18n),
      readString(address, SELECTOR.logo).catch(() => "")
    ]);

    return {
      address,
      symbol: symbol || fallbackSymbol || address.slice(0, 6),
      name: name || symbol || fallbackSymbol || "Pair asset",
      decimals: Number(decimals || 18n),
      logo: logo || "",
      isNative: false
    };
  }

  async function getApprovedPairAssets() {
    const candidates = new Map();
    candidates.set(ZERO_ADDRESS, { address: ZERO_ADDRESS, symbol: "ETH" });

    // Fallback candidates ensure common assets still appear if the approval
    // history cannot be scanned from the current RPC. They are verified
    // against the factory before being returned.
    for (const [symbol, address] of FALLBACK_PAIR_CANDIDATES) {
      candidates.set(address.toLowerCase(), { address, symbol });
    }

    // The live Pons V2 source of truth is the factory's approval history.
    // PairTokenApprovalUpdated(address indexed pairToken, bool approved)
    // lets us reconstruct the current set without trusting a third-party API.
    try {
      const head = await getBlockNumber();
      const start = Math.max(0, head - 1000000);
      const logs = await scanLogs(
        FACTORY_V2,
        start,
        head,
        [TOPIC_PAIR_APPROVAL_UPDATED]
      );

      const live = new Map();
      for (const log of logs) {
        const topics = log.topics || [];
        if (topics.length < 2) continue;
        const pair = normalizeAddress(decodeAddress(topics[1]));
        if (!pair) continue;
        const data = (log.data || "0x").replace(/^0x/, "");
        const approved = data.length >= 64 && decodeUint(data.slice(0, 64)) !== 0n;
        live.set(pair.toLowerCase(), { address: pair, approved });
      }

      for (const [key, value] of live) {
        if (value.approved) candidates.set(key, value);
        else candidates.delete(key);
      }
    } catch (e) {
      console.warn("[Ponsly] Pair approval history unavailable; using verified fallback candidates.", e);
    }

    // Final authority check: approvedPairTokens(address). This also removes
    // stale entries if an approval event is outside the scan window.
    const entries = Array.from(candidates.entries());
    const verified = [];
    for (let i = 0; i < entries.length; i += 8) {
      const batch = entries.slice(i, i + 8);
      const checks = await Promise.all(batch.map(async ([key, meta]) => {
        if (key === ZERO_ADDRESS) return true;
        return readApprovedPair(meta.address);
      }));
      batch.forEach(([key, meta], index) => {
        if (checks[index]) verified.push(meta.address);
      });
    }

    const assets = await Promise.all(verified.map(address => {
      const fallback = candidates.get(address.toLowerCase()) || {};
      return getPairMetadata(address, fallback.symbol);
    }));

    return assets.sort((a, b) => {
      if (a.isNative) return -1;
      if (b.isNative) return 1;
      return a.symbol.localeCompare(b.symbol);
    });
  }

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
    // Pons V2 uses address(0) for native ETH. Custom pairs are ERC-20s.
    // Read the pair metadata from the actual pair contract so the swap
    // selector can show the real pair logo (NVDA, USDG, GLD, etc.).
    const rawPairToken = launch && launch.pairToken
      ? launch.pairToken
      : null;
    const pairIsNative = !rawPairToken ||
      rawPairToken.toLowerCase() === ZERO_ADDRESS;

    let pairTokenName = pairIsNative ? "Ether" : "";
    let pairTokenSymbol = pairIsNative ? "ETH" : "";
    let pairDecimals = 18;
    let pairLogo = pairIsNative ? ETH_LOGO_DATA_URI : "";

    if (!pairIsNative) {
      try {
        const [pairName, pairSymbol, pairDecimalsRaw, pairLogoOnchain] = await Promise.all([
          readString(rawPairToken, SELECTOR.name),
          readString(rawPairToken, SELECTOR.symbol),
          readUint(rawPairToken, SELECTOR.decimals),
          readString(rawPairToken, SELECTOR.logo)
        ]);

        pairTokenName = pairName || "";
        pairTokenSymbol = pairSymbol || "";
        pairDecimals = Number(pairDecimalsRaw || 18n);
        pairLogo = pairLogoOnchain || "";
      } catch {
        // Keep the pair address even if optional metadata fails.
      }

      // Some canonical Robinhood assets expose their image through
      // Blockscout even when logo() is not implemented by the ERC-20.
      if (!pairLogo) {
        pairLogo = await resolveExternalTokenLogo(rawPairToken);
      }
    }

    return {
      tokenAddress: token,
      tokenName: name || token,
      tokenSymbol: symbol || "",
      decimals: Number(decimals || 18n),
      tokenDecimals: Number(decimals || 18n),
      totalSupply: totalSupply.toString(),

      logo: logo || "",
      tokenImage: logo || "",
      image: logo || "",

      description: description || "",

      poolAddress: resolvedPool,
      liquidityPool: resolvedPool,
      dextoolsPairId,

      pairToken: rawPairToken || null,
      pairTokenName: pairTokenName || "",
      pairSymbol: pairTokenSymbol || "",
      pairDecimals,
      pairLogo: pairLogo || "",
      pairImage: pairLogo || "",
      isNativePair: pairIsNative,
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

    getExplorerTokenUrl,
    getExplorerTxUrl,
    getExplorerPoolUrl,

    isReady: true
  };

  console.log("[Ponsly] token.js loaded — Robinhood Chain 4663 (Pons V2)");
})();
