/**
 * js/pons.js
 * -----------------------------------------------------------------------
 * Ponsly x pons — read-only protocol integration layer.
 *
 * Every contract address, function signature, event signature, and phase
 * mapping below is taken directly from the official pons documentation:
 *
 *   v1  https://docs.ponsfamily.com/          ("current" / legacy pons)
 *   v2  https://docs.ponsfamily.com/v2        (bonding curve + Uniswap v4)
 *
 * Function selectors and event topic0 hashes that are NOT given verbatim
 * as hex in the docs (pons-specific functions/events) were derived by
 * computing keccak256 of the exact signature string shown in the docs'
 * own code samples, and cross-checked against selectors that are public
 * knowledge (e.g. `balanceOf(address)` = 0x70a08231, `getReserves()` =
 * 0x0902f1ac) to confirm the derivation method itself is correct. Two
 * event topic0 values (v1 `TokenLaunched`, v1 `Swap`) are copied verbatim
 * from the docs, which publish them directly as hex.
 *
 * Scope of this file (and nothing more):
 *   - Resolve an arbitrary token address to its pons v1 or v2 launch
 *     record, purely from onchain reads.
 *   - Read token/pair metadata, phase, price, and graduation-derived
 *     market data where a verified read exists.
 *   - Read recent trades from documented onchain events.
 *
 * Explicitly OUT of scope / not implemented, by design:
 *   - No demo/mock tokens, prices, liquidity, market cap, trades or
 *     holders. Unavailable data is null or [], never fabricated.
 *   - No wallet connection, signing, or transactions of any kind.
 *   - No GMGN usage of any kind (see js/gmgn.js for the chart, which is
 *     entirely separate and never imported here).
 *   - No guessed contract addresses, ABIs, function names, event
 *     signatures, or indexer endpoints.
 * -----------------------------------------------------------------------
 */

(function () {
  'use strict';

  // =======================================================================
  // Network (docs.ponsfamily.com "Network" / "Integration" sections)
  // =======================================================================

  var ROBINHOOD_CHAIN_ID = 4663;
  var RPC_URL = 'https://rpc.mainnet.chain.robinhood.com'; // docs.ponsfamily.com: "Public RPC"
  var EXPLORER_BASE_URL = 'https://robinhoodchain.blockscout.com'; // docs.ponsfamily.com: "Explorer"

  var ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  var EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

  // =======================================================================
  // Verified deployed addresses
  // Source: docs.ponsfamily.com "Contracts" (v1) and
  //         docs.ponsfamily.com/v2 "Deployed addresses" (v2)
  // =======================================================================

  var V1_ACTIVE_FACTORY = '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB'; // start block 8991118
  var V1_LEGACY_FACTORY = '0x0c37a24F5D23A486FA692d1500881d698B1F77a4'; // start block 8600612
  var V2_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';

  // Reference token, per docs.ponsfamily.com "Reference token" — useful for
  // callers that want a known-good address to sanity-check an integration.
  // NOT used anywhere internally as a fallback/default token.
  var PONS_REFERENCE_TOKEN = '0x39dBED3a2bd333467115dE45665cC57F813C4571';

  // =======================================================================
  // Verified function selectors (4-byte keccak256 of the exact signature).
  // Signatures are exactly as documented; see file header for how these
  // were derived and verified.
  // =======================================================================

  var SEL = {
    // Standard ERC-20 (well-known selectors)
    name: '0x06fdde03', // name()
    symbol: '0x95d89b41', // symbol()
    decimals: '0x313ce567', // decimals()
    totalSupply: '0x18160ddd', // totalSupply()

    // v1 launch token (docs.ponsfamily.com "Reading token state")
    logo: '0xfb7f21eb', // logo()
    liquidityPool: '0x665a11ca', // liquidityPool()

    // v1 & v2 factory — identical signature, different return struct per
    // factory, so one selector serves both (see resolveV1Launch/V2 below).
    getLaunchedToken: '0x3cf28b5a', // getLaunchedToken(address)

    // v1 factory (docs.ponsfamily.com "Pricing and graduation")
    graduationStatus: '0x98d652f1', // graduationStatus(address)

    // v1 pool — standard Uniswap V3 pool read
    slot0: '0x3850c7bd', // slot0()

    // v2 curve (docs.ponsfamily.com/v2 "Reading state" / "Getting a quote")
    getReserves: '0x0902f1ac', // getReserves()
    realQuoteReserve: '0x4f1f58fd', // realQuoteReserve()
    graduationThreshold: '0x8b0bc501', // graduationThreshold()
    readyToGraduate: '0xc68360a5', // readyToGraduate()
    graduated: '0xe7c2b772' // graduated()
  };

  // Event topic0. The two v1 values are published verbatim as hex by the
  // docs; the two v2 values are derived from the exact event signatures
  // shown in "Events to index".
  var TOPIC_V1_SWAP =
    '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'; // docs.ponsfamily.com "Onchain events" (Uniswap V3 Swap)
  var TOPIC_V2_CURVE_BUY =
    '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455'; // CurveBuy(address,address,uint256,uint256,uint256,uint256)
  var TOPIC_V2_CURVE_SELL =
    '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df'; // CurveSell(address,address,uint256,uint256,uint256,uint256)

  // =======================================================================
  // Tunables for bounded event-log scanning (recent trades only). pons'
  // own docs warn the public RPC times out on wide eth_getLogs ranges and
  // recommend bounded backfill chunks — these constants implement that.
  // =======================================================================

  var TRADES_WANTED = 20;
  var LOG_CHUNK_BLOCKS = 3000;
  var LOG_MAX_CHUNKS = 10;

  // =======================================================================
  // Minimal JSON-RPC client (read-only)
  // =======================================================================

  var _rpcId = 1;
  var _chainIdChecked = false;

  async function rpcCall(method, params) {
    var res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: _rpcId++,
        method: method,
        params: params
      })
    });
    var json = await res.json();
    if (json.error) {
      throw new Error('RPC ' + method + ' error: ' + json.error.message);
    }
    return json.result;
  }

  async function ensureChain() {
    if (_chainIdChecked) return;
    _chainIdChecked = true;
    try {
      var hex = await rpcCall('eth_chainId', []);
      var id = parseInt(hex, 16);
      if (id !== ROBINHOOD_CHAIN_ID) {
        console.warn(
          'Ponsly/pons.js: RPC at',
          RPC_URL,
          'reports chainId',
          id,
          'but expected Robinhood Chain (' + ROBINHOOD_CHAIN_ID + ').'
        );
      }
    } catch (e) {
      console.warn('Ponsly/pons.js: could not verify chain id.', e);
    }
  }

  async function ethCall(to, data) {
    await ensureChain();
    try {
      var result = await rpcCall('eth_call', [{ to: to, data: data }, 'latest']);
      if (!result || result === '0x') return null;
      return result;
    } catch (e) {
      console.warn('Ponsly/pons.js: eth_call to', to, 'failed.', e);
      return null;
    }
  }

  async function ethBlockNumber() {
    var hex = await rpcCall('eth_blockNumber', []);
    return parseInt(hex, 16);
  }

  async function ethGetLogs(params) {
    try {
      return await rpcCall('eth_getLogs', [params]);
    } catch (e) {
      console.warn('Ponsly/pons.js: eth_getLogs failed.', e);
      return [];
    }
  }

  async function ethGetBlockTimestamp(blockNumber) {
    try {
      var block = await rpcCall('eth_getBlockByNumber', [
        '0x' + blockNumber.toString(16),
        false
      ]);
      if (!block || !block.timestamp) return null;
      return parseInt(block.timestamp, 16);
    } catch (e) {
      return null;
    }
  }

  // =======================================================================
  // Minimal ABI encode/decode helpers (only what this module needs)
  // =======================================================================

  function isValidAddress(address) {
    return typeof address === 'string' && EVM_ADDRESS_RE.test(address.trim());
  }

  function normalizeAddress(address) {
    return address.trim().toLowerCase();
  }

  function encodeAddressArg(addr) {
    return '000000000000000000000000' + addr.replace(/^0x/, '').toLowerCase();
  }

  function calldata(selector, addr) {
    return addr ? selector + encodeAddressArg(addr) : selector;
  }

  function words(hex) {
    var h = hex.startsWith('0x') ? hex.slice(2) : hex;
    var out = [];
    for (var i = 0; i < h.length; i += 64) {
      out.push(h.slice(i, i + 64));
    }
    return out;
  }

  function wordToAddress(w) {
    return '0x' + w.slice(24);
  }

  function wordToBigInt(w) {
    return BigInt('0x' + (w || '0'));
  }

  function wordToBool(w) {
    return wordToBigInt(w) !== 0n;
  }

  function wordToUint8(w) {
    return Number(wordToBigInt(w) & 0xffn);
  }

  function wordToInt256(w) {
    var v = wordToBigInt(w);
    var MAX = 2n ** 255n;
    if (v >= MAX) v -= 2n ** 256n;
    return v;
  }

  function decodeDynamicString(hex) {
    try {
      var w = words(hex);
      if (w.length < 2) return null;
      var offsetWordIndex = Number(wordToBigInt(w[0]) / 32n);
      var len = Number(wordToBigInt(w[offsetWordIndex]));
      if (len === 0) return '';
      var dataStart = offsetWordIndex + 1;
      var hexChars = '';
      var collected = 0;
      var i = dataStart;
      while (collected < len && i < w.length) {
        hexChars += w[i];
        collected += 32;
        i++;
      }
      var byteHex = hexChars.slice(0, len * 2);
      var bytes = new Uint8Array(byteHex.length / 2);
      for (var b = 0; b < bytes.length; b++) {
        bytes[b] = parseInt(byteHex.substr(b * 2, 2), 16);
      }
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      return null;
    }
  }

  async function readString(addr, selector) {
    var hex = await ethCall(addr, calldata(selector));
    if (!hex) return null;
    return decodeDynamicString(hex);
  }

  async function readUint8(addr, selector) {
    var hex = await ethCall(addr, calldata(selector));
    if (!hex) return null;
    return wordToUint8(words(hex)[0]);
  }

  async function readAddress(addr, selector) {
    var hex = await ethCall(addr, calldata(selector));
    if (!hex) return null;
    return wordToAddress(words(hex)[0]);
  }

  function formatUnits(bigintValue, decimals, maxFrac) {
    if (bigintValue === null || bigintValue === undefined) return null;
    if (decimals === null || decimals === undefined) return null;
    maxFrac = maxFrac === undefined ? 6 : maxFrac;
    var neg = bigintValue < 0n;
    var v = neg ? -bigintValue : bigintValue;
    var base = 10n ** BigInt(decimals);
    var whole = v / base;
    var frac = v % base;
    var fracStr = frac.toString().padStart(decimals, '0').slice(0, maxFrac);
    fracStr = fracStr.replace(/0+$/, '');
    var out = whole.toString() + (fracStr ? '.' + fracStr : '');
    return (neg ? '-' : '') + out;
  }

  function toNumberUnits(bigintValue, decimals) {
    if (bigintValue === null || bigintValue === undefined) return null;
    if (decimals === null || decimals === undefined) return null;
    var str = formatUnits(bigintValue, decimals, 18);
    var n = Number(str);
    return Number.isFinite(n) ? n : null;
  }

  // =======================================================================
  // ERC-20 metadata (any token — no assumption about existence or decimals)
  // =======================================================================

  async function readErc20Meta(addr) {
    var name = await readString(addr, SEL.name);
    var symbol = await readString(addr, SEL.symbol);
    var decimals = await readUint8(addr, SEL.decimals);
    return { name: name, symbol: symbol, decimals: decimals };
  }

  async function readPairMeta(pairAddr) {
    if (pairAddr === ZERO_ADDRESS) {
      return {
        isNativePair: true,
        pairToken: null,
        pairSymbol: 'ETH',
        pairName: 'Ether',
        pairDecimals: 18
      };
    }
    var meta = await readErc20Meta(pairAddr);
    return {
      isNativePair: false,
      pairToken: pairAddr,
      pairSymbol: meta.symbol,
      pairName: meta.name,
      pairDecimals: meta.decimals
    };
  }

  // =======================================================================
  // Launch resolution — v2 first (current protocol version), then v1
  // active factory, then v1 legacy factory. Never mixes v1/v2 logic for
  // a single token: whichever factory reports `exists = true` decides
  // which set of contracts and reads apply.
  // =======================================================================

  async function resolveV2Launch(tokenAddr) {
    var hex = await ethCall(V2_FACTORY, calldata(SEL.getLaunchedToken, tokenAddr));
    if (!hex) return null;
    var w = words(hex);
    if (w.length < 15) return null;
    var exists = wordToBool(w[14]);
    if (!exists) return null;
    return {
      token: wordToAddress(w[0]),
      curve: wordToAddress(w[1]),
      deployer: wordToAddress(w[2]),
      creatorFeeRecipient: wordToAddress(w[3]),
      pairToken: wordToAddress(w[4]),
      graduationThreshold: wordToBigInt(w[5]),
      poolFee: Number(wordToBigInt(w[6])),
      tickSpacing: Number(wordToInt256(w[7])),
      creatorTaxBps: Number(wordToBigInt(w[8])),
      buybackEnabled: wordToBool(w[9]),
      phase: wordToUint8(w[10]) // 0 NotGraduated, 1 Swept, 2 PoolCreated, 3 Rescued
    };
  }

  async function resolveV1Launch(tokenAddr, factoryAddr) {
    var hex = await ethCall(factoryAddr, calldata(SEL.getLaunchedToken, tokenAddr));
    if (!hex) return null;
    var w = words(hex);
    if (w.length < 13) return null;
    var exists = wordToBool(w[11]);
    if (!exists) return null;
    return {
      token: wordToAddress(w[0]),
      deployer: wordToAddress(w[1]),
      pairedToken: wordToAddress(w[2]),
      positionManager: wordToAddress(w[3]),
      positionId: wordToBigInt(w[4]),
      dexId: wordToBigInt(w[5]),
      launchConfigId: wordToBigInt(w[6]),
      restrictionsEndBlock: wordToBigInt(w[7]),
      supply: wordToBigInt(w[8]),
      isToken0: wordToBool(w[9]),
      poolFee: Number(wordToBigInt(w[10])),
      factory: factoryAddr
    };
  }

  /**
   * Resolve a token into a normalized launch context, or null if it is
   * not a token launched through pons v1 or v2 (as far as this module can
   * verify from the factories above).
   */
  async function resolveLaunchContext(tokenAddr, tokenMeta) {
    var v2 = await resolveV2Launch(tokenAddr);
    if (v2) {
      var pairMetaV2 = await readPairMeta(v2.pairToken);
      var phase = v2.phase === 0 ? 'curve' : v2.phase === 2 ? 'pool' : null;
      if (phase === null) {
        console.warn(
          'Ponsly/pons.js: token',
          tokenAddr,
          'is in v2 phase',
          v2.phase,
          '(Swept or Rescued) — not mapped to curve/pool, treating as unavailable rather than guessing.'
        );
      }
      return {
        version: 'v2',
        phase: phase,
        rawPhase: v2.phase,
        venue: v2.curve, // curve contract; no discrete pool address exists pre-graduation
        curve: v2.curve,
        isToken0: null, // not applicable to v2 curve pricing
        pair: pairMetaV2,
        tokenDecimals: tokenMeta.decimals
      };
    }

    var v1 =
      (await resolveV1Launch(tokenAddr, V1_ACTIVE_FACTORY)) ||
      (await resolveV1Launch(tokenAddr, V1_LEGACY_FACTORY));
    if (v1) {
      var pairMetaV1 = await readPairMeta(v1.pairedToken);
      var poolAddr = await readAddress(tokenAddr, SEL.liquidityPool);
      return {
        version: 'v1',
        phase: 'pool', // v1 docs: no bonding curve, trades in the pool from launch
        rawPhase: null,
        venue: poolAddr,
        curve: null,
        isToken0: v1.isToken0,
        pair: pairMetaV1,
        tokenDecimals: tokenMeta.decimals
      };
    }

    return null;
  }

  // =======================================================================
  // Price reads
  // =======================================================================

  // v1: Uniswap V3 slot0 pricing (docs.ponsfamily.com "Pricing and graduation")
  async function readV1Price(poolAddr, isToken0, tokenDecimals, pairDecimals) {
    if (!poolAddr || tokenDecimals === null || pairDecimals === null) return null;
    var hex = await ethCall(poolAddr, calldata(SEL.slot0));
    if (!hex) return null;
    var w = words(hex);
    var sqrtPriceX96 = wordToBigInt(w[0]);
    if (sqrtPriceX96 === 0n) return null;

    // Uniswap V3 price math: (sqrtPriceX96 / 2^96)^2 = token1 per token0,
    // in raw (undecimalled) integer units.
    var ratio = Number(sqrtPriceX96) / Math.pow(2, 96);
    var rawToken1PerToken0 = ratio * ratio;

    var decimals0 = isToken0 ? tokenDecimals : pairDecimals;
    var decimals1 = isToken0 ? pairDecimals : tokenDecimals;
    var realToken1PerToken0 =
      rawToken1PerToken0 * Math.pow(10, decimals0 - decimals1);

    var priceOfTokenInPair = isToken0
      ? realToken1PerToken0
      : realToken1PerToken0 === 0
      ? null
      : 1 / realToken1PerToken0;

    return Number.isFinite(priceOfTokenInPair) ? priceOfTokenInPair : null;
  }

  // v2 curve: marginal price from reserves (docs.ponsfamily.com/v2 "Reading state")
  async function readV2CurvePrice(curveAddr, tokenDecimals, pairDecimals) {
    if (!curveAddr || tokenDecimals === null || pairDecimals === null) return null;
    var hex = await ethCall(curveAddr, calldata(SEL.getReserves));
    if (!hex) return null;
    var w = words(hex);
    var quoteReserve = wordToBigInt(w[0]);
    var tokenReserve = wordToBigInt(w[1]);
    if (tokenReserve === 0n) return null;
    var quoteReal = toNumberUnits(quoteReserve, pairDecimals);
    var tokenReal = toNumberUnits(tokenReserve, tokenDecimals);
    if (quoteReal === null || tokenReal === null || tokenReal === 0) return null;
    return quoteReal / tokenReal;
  }

  // =======================================================================
  // Public: getTokenData
  // =======================================================================

  async function getTokenData(tokenAddress) {
    try {
      if (!isValidAddress(tokenAddress)) {
        console.warn('Ponsly/pons.js: invalid token address passed to getTokenData().');
        return null;
      }
      var addr = normalizeAddress(tokenAddress);

      var tokenMeta = await readErc20Meta(addr);
      if (tokenMeta.name === null && tokenMeta.symbol === null) {
        console.warn(
          'Ponsly/pons.js: no ERC-20 contract (or no code) found at',
          addr
        );
        return null;
      }

      var result = {
        tokenAddress: addr,
        tokenName: tokenMeta.name,
        tokenSymbol: tokenMeta.symbol,
        tokenDecimals: tokenMeta.decimals,
        tokenImage: null,

        pairToken: null,
        pairSymbol: null,
        pairName: null,
        pairDecimals: null,
        isNativePair: null,

        phase: null,

        price: null,
        priceQuoteAsset: null,
        changePct: null,

        marketCap: null,
        liquidity: null,
        volume24h: null,
        ath: null,

        poolAddress: null,

        explorerBaseUrl: EXPLORER_BASE_URL,
        dexscreenerUrl: null,
        geckoTerminalUrl: null
      };

      var ctx = await resolveLaunchContext(addr, tokenMeta);
      if (!ctx) {
        console.warn(
          'Ponsly/pons.js: token',
          addr,
          'was not found in the v2 or v1 pons factories — not a pons launch (or not verifiable).'
        );
        return result; // still return real ERC-20 metadata; pons-specific fields stay null
      }

      result.pairToken = ctx.pair.pairToken;
      result.pairSymbol = ctx.pair.pairSymbol;
      result.pairName = ctx.pair.pairName;
      result.pairDecimals = ctx.pair.pairDecimals;
      result.isNativePair = ctx.pair.isNativePair;
      result.phase = ctx.phase;
      result.priceQuoteAsset = ctx.pair.pairSymbol;

      if (ctx.version === 'v1') {
        result.poolAddress = ctx.venue;
        result.price = await readV1Price(
          ctx.venue,
          ctx.isToken0,
          tokenMeta.decimals,
          ctx.pair.pairDecimals
        );
        var logo = await readString(addr, SEL.logo);
        result.tokenImage = logo || null;
      } else if (ctx.version === 'v2') {
        if (ctx.phase === 'curve') {
          result.poolAddress = ctx.curve; // active trading venue pre-graduation
          result.price = await readV2CurvePrice(
            ctx.curve,
            tokenMeta.decimals,
            ctx.pair.pairDecimals
          );
        } else if (ctx.phase === 'pool') {
          // Graduated into a Uniswap v4 pool. pons docs show how to build the
          // pool key/poolId, but do not document a PoolManager/StateView
          // address on Robinhood Chain for reading live price from a v4
          // pool, so this is intentionally left unavailable rather than
          // guessed.
          console.warn(
            'Ponsly/pons.js: token',
            addr,
            'has graduated to a Uniswap v4 pool. pons docs do not document a' +
              ' price-read mechanism for v4 pools on Robinhood Chain, so price is unavailable.'
          );
          result.poolAddress = null;
        }
        // tokenImage for v2 requires decoding getTokenInfo()'s nested
        // dynamic-string tuple; not implemented in this lightweight module
        // (see notes returned to the user). Left as null rather than risk
        // an incorrect decode.
      }

      if (result.price !== null && tokenMeta.decimals !== null) {
        var totalSupplyHex = await ethCall(addr, calldata(SEL.totalSupply));
        if (totalSupplyHex) {
          var totalSupply = wordToBigInt(words(totalSupplyHex)[0]);
          var supplyReal = toNumberUnits(totalSupply, tokenMeta.decimals);
          if (supplyReal !== null) {
            result.marketCap = result.price * supplyReal;
          }
        }
      }

      // liquidity, volume24h, ath, changePct: not obtainable from a single
      // verified pons/onchain read (pons documents raw reserves, not a
      // single "liquidity" or historical figure, and there is no pons
      // API/indexer — "no pons API in the trust path"). Left null rather
      // than approximated.

      // dexscreenerUrl / geckoTerminalUrl: constructing these requires a
      // chain-slug identifier for Robinhood Chain on those third-party
      // sites, which is not documented by pons and was not independently
      // verified here. Left null rather than guessed (same policy as the
      // GMGN chain identifier in js/gmgn.js).

      return result;
    } catch (err) {
      console.warn('Ponsly/pons.js: getTokenData failed.', err);
      return null;
    }
  }

  // =======================================================================
  // Public: getRecentTrades
  // =======================================================================

  async function scanLogsBackward(address, topics) {
    var latest = await ethBlockNumber();
    var collected = [];
    var toBlock = latest;
    for (var chunk = 0; chunk < LOG_MAX_CHUNKS && collected.length < TRADES_WANTED; chunk++) {
      var fromBlock = Math.max(0, toBlock - LOG_CHUNK_BLOCKS + 1);
      var logs = await ethGetLogs({
        address: address,
        topics: topics,
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16)
      });
      if (logs && logs.length) collected = collected.concat(logs);
      if (fromBlock === 0) break;
      toBlock = fromBlock - 1;
    }
    return collected;
  }

  async function getRecentTrades(tokenAddress) {
    try {
      if (!isValidAddress(tokenAddress)) {
        console.warn('Ponsly/pons.js: invalid token address passed to getRecentTrades().');
        return [];
      }
      var addr = normalizeAddress(tokenAddress);
      var tokenMeta = await readErc20Meta(addr);
      if (tokenMeta.decimals === null) return [];

      var ctx = await resolveLaunchContext(addr, tokenMeta);
      if (!ctx) return [];

      var rawLogs = [];
      if (ctx.version === 'v1' && ctx.phase === 'pool' && ctx.venue) {
        rawLogs = await scanLogsBackward(ctx.venue, [TOPIC_V1_SWAP]);
      } else if (ctx.version === 'v2' && ctx.phase === 'curve' && ctx.curve) {
        var buyLogs = await scanLogsBackward(ctx.curve, [TOPIC_V2_CURVE_BUY]);
        var sellLogs = await scanLogsBackward(ctx.curve, [TOPIC_V2_CURVE_SELL]);
        rawLogs = buyLogs.concat(sellLogs);
      } else if (ctx.version === 'v2' && ctx.phase === 'pool') {
        console.warn(
          'Ponsly/pons.js: recent trades for a graduated v2 (Uniswap v4) token' +
            ' require indexing the v4 PoolManager, whose address on Robinhood' +
            ' Chain is not documented by pons — returning [] rather than guessing.'
        );
        return [];
      } else {
        return [];
      }

      if (!rawLogs.length) return [];

      rawLogs.sort(function (a, b) {
        return parseInt(b.blockNumber, 16) - parseInt(a.blockNumber, 16);
      });
      rawLogs = rawLogs.slice(0, TRADES_WANTED);

      var blockTimestamps = {};
      for (var i = 0; i < rawLogs.length; i++) {
        var bn = rawLogs[i].blockNumber;
        if (!(bn in blockTimestamps)) {
          blockTimestamps[bn] = await ethGetBlockTimestamp(parseInt(bn, 16));
        }
      }

      var trades = [];
      for (var j = 0; j < rawLogs.length; j++) {
        var log = rawLogs[j];
        var trade = null;
        if (log.topics[0].toLowerCase() === TOPIC_V1_SWAP) {
          trade = decodeV1Swap(log, ctx, tokenMeta);
        } else if (log.topics[0].toLowerCase() === TOPIC_V2_CURVE_BUY) {
          trade = decodeV2Curve(log, ctx, tokenMeta, 'buy');
        } else if (log.topics[0].toLowerCase() === TOPIC_V2_CURVE_SELL) {
          trade = decodeV2Curve(log, ctx, tokenMeta, 'sell');
        }
        if (trade) {
          var ts = blockTimestamps[log.blockNumber];
          trade.time = ts ? new Date(ts * 1000).toISOString() : null;
          trades.push(trade);
        }
      }

      return trades;
    } catch (err) {
      console.warn('Ponsly/pons.js: getRecentTrades failed.', err);
      return [];
    }
  }

  function decodeV1Swap(log, ctx, tokenMeta) {
    try {
      var d = words(log.data);
      var amount0 = wordToInt256(d[0]);
      var amount1 = wordToInt256(d[1]);
      var tokenSigned = ctx.isToken0 ? amount0 : amount1;
      var pairSigned = ctx.isToken0 ? amount1 : amount0;
      var side = pairSigned > 0n ? 'buy' : 'sell';
      var tokenAbs = tokenSigned < 0n ? -tokenSigned : tokenSigned;
      var pairAbs = pairSigned < 0n ? -pairSigned : pairSigned;
      var tokenReal = toNumberUnits(tokenAbs, tokenMeta.decimals);
      var pairReal = toNumberUnits(pairAbs, ctx.pair.pairDecimals);
      var price =
        tokenReal && pairReal !== null && tokenReal !== 0
          ? pairReal / tokenReal
          : null;
      var wallet = '0x' + log.topics[2].slice(26);
      return {
        type: side,
        amount: formatUnits(tokenAbs, tokenMeta.decimals),
        ticker: tokenMeta.symbol,
        wallet: wallet,
        price: price !== null ? price.toString() : null
      };
    } catch (e) {
      return null;
    }
  }

  function decodeV2Curve(log, ctx, tokenMeta, side) {
    try {
      var d = words(log.data);
      var quoteAmount, tokenAmount;
      if (side === 'buy') {
        quoteAmount = wordToBigInt(d[0]); // quoteIn
        tokenAmount = wordToBigInt(d[1]); // tokensOut
      } else {
        tokenAmount = wordToBigInt(d[0]); // tokensIn
        quoteAmount = wordToBigInt(d[1]); // quoteOut
      }
      var tokenReal = toNumberUnits(tokenAmount, tokenMeta.decimals);
      var quoteReal = toNumberUnits(quoteAmount, ctx.pair.pairDecimals);
      var price =
        tokenReal && quoteReal !== null && tokenReal !== 0
          ? quoteReal / tokenReal
          : null;
      var wallet = '0x' + log.topics[1].slice(26); // buyer / seller
      return {
        type: side,
        amount: formatUnits(tokenAmount, tokenMeta.decimals),
        ticker: tokenMeta.symbol,
        wallet: wallet,
        price: price !== null ? price.toString() : null
      };
    } catch (e) {
      return null;
    }
  }

  // =======================================================================
  // Public: getHolders
  // =======================================================================

  async function getHolders(tokenAddress) {
    if (!isValidAddress(tokenAddress)) {
      console.warn('Ponsly/pons.js: invalid token address passed to getHolders().');
      return null;
    }
    // pons does not document a holders API, indexer, or subgraph. The docs'
    // only suggestion is to "optionally index token Transfer events for
    // holder balances" yourself — reconstructing accurate, complete holder
    // balances that way means scanning full Transfer history since token
    // creation, which is unbounded for an arbitrary token and unsafe to
    // approximate here. Returning null rather than a partial/misleading
    // holder list. A dedicated indexer/subgraph is the correct tool for
    // this, not a lightweight browser-side read.
    console.warn(
      'Ponsly/pons.js: getHolders() is unavailable — pons documents no' +
        ' holders API/indexer; a full Transfer-event index is required and' +
        ' is out of scope for this module.'
    );
    return null;
  }

  // =======================================================================
  // Expose
  // =======================================================================

  window.PonslyPons = {
    getTokenData: getTokenData,
    getRecentTrades: getRecentTrades,
    getHolders: getHolders,
    ROBINHOOD_CHAIN_ID: ROBINHOOD_CHAIN_ID,
    EXPLORER_BASE_URL: EXPLORER_BASE_URL
  };
})();
