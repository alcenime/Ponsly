/* ============================================================
 * Ponsly — Pons Read-Only Onchain Adapter
 * Robinhood Chain
 *
 * Chain ID : 4663
 * RPC      : https://rpc.mainnet.chain.robinhood.com
 *
 * READ ONLY:
 * - token metadata
 * - launch discovery
 * - canonical pool
 * - spot price
 * - real QuoterV2 quote
 * - recent Swap events
 * - TokenLaunched discovery
 *
 * NO:
 * - wallet connection
 * - approval
 * - transaction
 * - swap execution
 * - fake/mock data
 * ============================================================ */

(function () {
  "use strict";

  // ============================================================
  // NETWORK
  // ============================================================

  const CHAIN_ID = 4663;

  const RPC_URL =
    "https://rpc.mainnet.chain.robinhood.com";

  const EXPLORER_BASE_URL =
    "https://robinhoodchain.blockscout.com";


  // ============================================================
  // PONS CONTRACTS
  // ============================================================

  const ACTIVE_FACTORY =
    "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB";

  const ACTIVE_FACTORY_START =
    8991118;

  const LEGACY_FACTORY =
    "0x0c37a24F5D23A486FA692d1500881d698B1F77a4";

  const LEGACY_FACTORY_START =
    8600612;

  const V3_FACTORY =
    "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";

  const QUOTER_V2 =
    "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";

  const WETH =
    "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";


  // ============================================================
  // REFERENCE PONS
  // ============================================================

  const PONS_REFERENCE_TOKEN =
    "0x39dBED3a2bd333467115dE45665cC57F813C4571";

  const PONS_REFERENCE_POOL =
    "0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA";


  // ============================================================
  // SELECTORS
  // ============================================================

  const SELECTOR = {

    name:
      "06fdde03",

    symbol:
      "95d89b41",

    decimals:
      "313ce567",

    totalSupply:
      "18160ddd",

    logo:
      "fb7f21eb",

    description:
      "7284e416",

    socials:
      "53cd512a",

    slot0:
      "3850c7bd",

    liquidity:
      "1a686502",

    token0:
      "0dfe1681",

    token1:
      "d21220a7",

    getPool:
      "1698ee82",

    quoteExactInputSingle:
      "c6a5026a"
  };


  // ============================================================
  // EVENTS
  // ============================================================

  const TOPIC = {

    TokenLaunched:
      "0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a",

    Swap:
      "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
  };


  // ============================================================
  // SETTINGS
  // ============================================================

  const ZERO =
    "0x0000000000000000000000000000000000000000";

  const LOG_CHUNK_BLOCKS =
    3000;

  const TRADE_LOOKBACK_BLOCKS =
    15000;

  const TOKEN_LOOKBACK_BLOCKS =
    60000;

  const MAX_TOKENS =
    30;

  const MAX_TRADES =
    30;


  // ============================================================
  // CACHE
  // ============================================================

  const cache =
    new Map();


  // ============================================================
  // ADDRESS HELPERS
  // ============================================================

  function isAddress(value) {

    return /^0x[a-fA-F0-9]{40}$/
      .
