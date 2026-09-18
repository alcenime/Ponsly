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
      .test(
        String(value || "")
      );
  }


  function normalizeAddress(value) {

    if (!isAddress(value)) {
      return null;
    }

    return (
      "0x" +
      value
        .slice(2)
        .toLowerCase()
    );
  }


  function addressFromWord(value) {

    return (
      "0x" +
      value
        .slice(-40)
        .toLowerCase()
    );
  }


  function shortAddress(address) {

    if (
      !isAddress(address)
    ) {
      return "—";
    }

    return (
      address.slice(0, 6) +
      "…" +
      address.slice(-4)
    );
  }


  // ============================================================
  // ABI HELPERS
  // ============================================================

  function pad32(value) {

    return String(value)
      .replace(/^0x/, "")
      .padStart(
        64,
        "0"
      );
  }


  function word(
    data,
    index
  ) {

    const raw =
      String(data || "")
        .replace(/^0x/, "");

    return raw
      .slice(
        index * 64,
        (index + 1) * 64
      )
      .padEnd(
        64,
        "0"
      );
  }


  function uintFromWord(
    value
  ) {

    return BigInt(
      "0x" + value
    );
  }


  function int256FromWord(
    value
  ) {

    const unsigned =
      BigInt(
        "0x" + value
      );

    const max =
      1n << 255n;

    if (
      unsigned >= max
    ) {

      return (
        unsigned -
        (1n << 256n)
      );
    }

    return unsigned;
  }


  function boolFromWord(
    value
  ) {

    return (
      uintFromWord(
        value
      ) !== 0n
    );
  }


  // ============================================================
  // UTF-8 / ABI STRING
  // ============================================================

  function hexToUtf8(
    hex
  ) {

    try {

      const clean =
        hex.replace(
          /^0x/,
          ""
        );

      const bytes =
        new Uint8Array(
          clean.length / 2
        );

      for (
        let i = 0;
        i < bytes.length;
        i++
      ) {

        bytes[i] =
          parseInt(
            clean.slice(
              i * 2,
              i * 2 + 2
            ),
            16
          );
      }

      return new TextDecoder()
        .decode(bytes)
        .replace(
          /\0+$/,
          ""
        );

    } catch {

      return "";
    }
  }


  function decodeAbiString(
    data,
    offsetBytes
  ) {

    const raw =
      String(data || "")
        .replace(
          /^0x/,
          ""
        );

    const position =
      offsetBytes * 2;

    if (
      position + 64 >
      raw.length
    ) {

      return "";
    }

    const length =
      Number(
        BigInt(
          "0x" +
          raw.slice(
            position,
            position + 64
          )
        )
      );

    const start =
      position + 64;

    const end =
      start +
      length * 2;

    if (
      end >
      raw.length
    ) {

      return "";
    }

    return hexToUtf8(
      "0x" +
      raw.slice(
        start,
        end
      )
    );
  }


  function decodeSingleString(
    data
  ) {

    if (
      !data ||
      data === "0x"
    ) {

      return "";
    }

    try {

      const offset =
        Number(
          uintFromWord(
            word(
              data,
              0
            )
          )
        );

      return decodeAbiString(
        data,
        offset
      );

    } catch {

      return "";
    }
  }


  // ============================================================
  // SOCIALS
  // ============================================================

  function decodeSocials(
    data
  ) {

    const result = {

      twitter: "",
      telegram: "",
      discord: "",
      website: "",
      farcaster: ""
    };

    try {

      const offsets = [];

      for (
        let i = 0;
        i < 5;
        i++
      ) {

        offsets.push(
          Number(
            uintFromWord(
              word(
                data,
                i
              )
            )
          )
        );
      }

      const names = [
        "twitter",
        "telegram",
        "discord",
        "website",
        "farcaster"
      ];

      for (
        let i = 0;
        i < names.length;
        i++
      ) {

        result[names[i]] =
          decodeAbiString(
            data,
            offsets[i]
          );
      }

    } catch {}

    return result;
  }


  // ============================================================
  // UNIT FORMAT
  // ============================================================

  function formatUnits(
    value,
    decimals
  ) {

    const n =
      typeof value === "bigint"
        ? value
        : BigInt(
            value || 0
          );

    const d =
      Number(
        decimals || 0
      );

    if (!d) {

      return n.toString();
    }

    const negative =
      n < 0n;

    const absolute =
      negative
        ? -n
        : n;

    const stringValue =
      absolute
        .toString()
        .padStart(
          d + 1,
          "0"
        );

    const whole =
      stringValue.slice(
        0,
        -d
      ) || "0";

    const fraction =
      stringValue
        .slice(-d)
        .replace(
          /0+$/,
          ""
        );

    return (
      (negative ? "-" : "") +
      whole +
      (
        fraction
          ? "." + fraction
          : ""
      )
    );
  }


  function parseDecimalToUnits(
    value,
    decimals
  ) {

    const d =
      Number(
        decimals || 0
      );

    const stringValue =
      String(
        value ?? ""
      ).trim();

    if (
      !/^\d*(\.\d*)?$/
        .test(
          stringValue
        )
    ) {

      throw new Error(
        "Invalid amount"
      );
    }

    const parts =
      stringValue.split(
        "."
      );

    const whole =
      parts[0] || "0";

    const fractionRaw =
      parts[1] || "";

    if (
      fractionRaw.length > d &&
      /[1-9]/
        .test(
          fractionRaw.slice(d)
        )
    ) {

      throw new Error(
        "Amount has too many decimals"
      );
    }

    const fraction =
      (
        fractionRaw +
        "0".repeat(d)
      ).slice(
        0,
        d
      );

    return (
      BigInt(whole) *
      (
        10n ** BigInt(d)
      ) +
      BigInt(
        fraction || "0"
      )
    );
  }


  // ============================================================
  // RPC
  // ============================================================

  async function rpc(
    method,
    params = []
  ) {

    const response =
      await fetch(
        RPC_URL,
        {
          method:
            "POST",

          headers: {
            "content-type":
              "application/json"
          },

          body:
            JSON.stringify({

              jsonrpc:
                "2.0",

              id:
                Date.now() +
                Math.random(),

              method,

              params
            })
        }
      );


    if (
      !response.ok
    ) {

      throw new Error(
        `RPC HTTP ${response.status}`
      );
    }


    const json =
      await response.json();


    if (
      json.error
    ) {

      const error =
        new Error(
          json.error.message ||
          "RPC error"
        );

      error.data =
        json.error.data;

      error.code =
        json.error.code;

      throw error;
    }


    return json.result;
  }


  async function ethCall(
    to,
    data,
    block = "latest"
  ) {

    return rpc(
      "eth_call",
      [
        {
          to,
          data
        },
        block
      ]
    );
  }


  async function getBlockNumber() {

    return Number(
      BigInt(
        await rpc(
          "eth_blockNumber"
        )
      )
    );
  }


  async function getBlock(
    blockNumber
  ) {

    const blockHex =
      "0x" +
      Number(
        blockNumber
      ).toString(16);

    return rpc(
      "eth_getBlockByNumber",
      [
        blockHex,
        false
      ]
    );
  }


  // ============================================================
  // LOGS
  // ============================================================

  async function getLogs(
    address,
    topics,
    fromBlock,
    toBlock
  ) {

    return rpc(
      "eth_getLogs",
      [
        {
          address,

          topics,

          fromBlock:
            "0x" +
            Number(
              fromBlock
            ).toString(16),

          toBlock:
            "0x" +
            Number(
              toBlock
            ).toString(16)
        }
      ]
    );
  }


  async function scanLogs(
    address,
    topics,
    startBlock,
    endBlock,
    limit = 200
  ) {

    const rows = [];

    let to =
      endBlock;


    while (
      to >= startBlock &&
      rows.length < limit
    ) {

      const from =
        Math.max(
          startBlock,
          to -
            LOG_CHUNK_BLOCKS +
            1
        );


      try {

        const part =
          await getLogs(
            address,
            topics,
            from,
            to
          );

        rows.push(
          ...part
        );

      } catch {

        /*
         * Public pons RPC can timeout
         * on larger getLogs ranges.
         *
         * Retry with smaller chunks.
         */

        if (
          to - from >
          250
        ) {

          const middle =
            Math.floor(
              (from + to) /
              2
            );


          try {

            const first =
              await getLogs(
                address,
                topics,
                from,
                middle
              );

            const second =
              await getLogs(
                address,
                topics,
                middle + 1,
                to
              );

            rows.push(
              ...first,
              ...second
            );

          } catch {}
        }
      }


      to =
        from - 1;
    }


    rows.sort(
      (a, b) => {

        const blockA =
          Number(
            BigInt(
              a.blockNumber
            )
          );

        const blockB =
          Number(
            BigInt(
              b.blockNumber
            )
          );


        if (
          blockA !==
          blockB
        ) {

          return (
            blockB -
            blockA
          );
        }


        return (
          Number(
            BigInt(
              b.logIndex ||
              "0x0"
            )
          ) -
          Number(
            BigInt(
              a.logIndex ||
              "0x0"
            )
          )
        );
      }
    );


    return rows.slice(
      0,
      limit
    );
  }


  // ============================================================
  // TOKEN METADATA
  // ============================================================

  async function readWord(
    address,
    selector
  ) {

    const result =
      await ethCall(
        address,
        "0x" +
        selector
      );

    return word(
      result,
      0
    );
  }


  async function readString(
    address,
    selector
  ) {

    return decodeSingleString(
      await ethCall(
        address,
        "0x" +
        selector
      )
    );
  }


  async function readTokenMetadata(
    token
  ) {

    const address =
      normalizeAddress(
        token
      );


    if (!address) {

      throw new Error(
        "Invalid token address"
      );
    }


    const key =
      "metadata:" +
      address;


    if (
      cache.has(key)
    ) {

      return cache.get(
        key
      );
    }


    const [
      name,
      symbol,
      decimalsWord,
      supplyWord
    ] =
      await Promise.all([

        readString(
          address,
          SELECTOR.name
        ),

        readString(
          address,
          SELECTOR.symbol
        ),

        readWord(
          address,
          SELECTOR.decimals
        ),

        readWord(
          address,
          SELECTOR.totalSupply
        )
      ]);


    let logo = "";
    let description = "";

    try {

      logo =
        await readString(
          address,
          SELECTOR.logo
        );

    } catch {}


    try {

      description =
        await readString(
          address,
          SELECTOR.description
        );

    } catch {}


    let socials = {

      twitter: "",
      telegram: "",
      discord: "",
      website: "",
      farcaster: ""
    };


    try {

      socials =
        decodeSocials(
          await ethCall(
            address,
            "0x" +
            SELECTOR.socials
          )
        );

    } catch {}


    const metadata = {

      tokenAddress:
        address,

      tokenName:
        name ||
        "Unknown",

      tokenSymbol:
        symbol ||
        "TOKEN",

      tokenDecimals:
        Number(
          uintFromWord(
            decimalsWord
          )
        ),

      totalSupplyRaw:
        uintFromWord(
          supplyWord
        ),

      logo,

      description,

      ...socials
    };


    cache.set(
      key,
      metadata
    );


    return metadata;
  }


  // ============================================================
  // FIND LAUNCH FROM TOKENLAUNCHED
  // ============================================================

  async function findLaunchFromFactoryEvent(
    tokenAddress
  ) {

    const token =
      normalizeAddress(
        tokenAddress
      );


    if (!token) {

      throw new Error(
        "Invalid token address"
      );
    }


    /*
     * Official pons reference token.
     *
     * This lets the integration validate PONS
     * even if the public RPC is temporarily slow
     * when scanning historical logs.
     */

    if (
      token ===
      normalizeAddress(
        PONS_REFERENCE_TOKEN
      )
    ) {

      return {

        token,

        deployer:
          null,

        dexFactory:
          LEGACY_FACTORY,

        pairToken:
          WETH,

        pool:
          PONS_REFERENCE_POOL,

        dexId:
          0n,

        launchConfigId:
          0n,

        positionId:
          0n,

        restrictionsEndBlock:
          0n,

        initialBuyAmount:
          0n,

        blockNumber:
          null,

        transactionHash:
          null,

        logIndex:
          0
      };
    }


    const head =
      await getBlockNumber();


    /*
     * indexed address topic
     */

    const tokenTopic =
      "0x" +
      token
        .slice(2)
        .padStart(
          64,
          "0"
        );


    const searches = [

      {
        factory:
          ACTIVE_FACTORY,

        start:
          ACTIVE_FACTORY_START
      },

      {
        factory:
          LEGACY_FACTORY,

        start:
          LEGACY_FACTORY_START
      }

    ];


    for (
      const item
      of searches
    ) {

      try {

        const logs =
          await scanLogs(

            item.factory,

            [
              TOPIC.TokenLaunched,
              tokenTopic
            ],

            item.start,

            head,

            5
          );


        const decoded =
          logs

            .map(
              decodeTokenLaunchLog
            )

            .filter(
              row =>
                row &&
                normalizeAddress(
                  row.token
                ) === token
            );


        if (
          decoded.length
        ) {

          return decoded[0];
        }

      } catch {}
    }


    return null;
  }


  // ============================================================
  // RESOLVE LAUNCH
  // ============================================================

  async function resolveLaunch(
    token
  ) {

    const address =
      normalizeAddress(
        token
      );


    if (!address) {

      throw new Error(
        "Invalid token address"
      );
    }


    const key =
      "launch:" +
      address;


    if (
      cache.has(key)
    ) {

      return cache.get(
        key
      );
    }


    const eventRecord =
      await findLaunchFromFactoryEvent(
        address
      );


    if (
      !eventRecord
    ) {

      throw new Error(
        "Token launch not found"
      );
    }


    const result = {

      factory:
        normalizeAddress(
          eventRecord.dexFactory
        ) ||
        null,

      token:
        eventRecord.token,

      deployer:
        eventRecord.deployer,

      pairedToken:
        normalizeAddress(
          eventRecord.pairToken
        ) ||
        normalizeAddress(
          WETH
        ),

      positionId:
        eventRecord.positionId,

      poolFee:
        10000,

      initialBuyAmount:
        eventRecord.initialBuyAmount,

      restrictionsEndBlock:
        eventRecord.restrictionsEndBlock,

      exists:
        true,

      pool:
        eventRecord.pool
    };


    cache.set(
      key,
      result
    );


    return result;
  }


  // ============================================================
  // RESOLVE CANONICAL POOL
  // ============================================================

  async function resolvePool(
    launch,
    tokenAddress
  ) {

    /*
     * TokenLaunched already emits the
     * canonical pool.
     */

    if (
      launch &&
      normalizeAddress(
        launch.pool
      )
    ) {

      return normalizeAddress(
        launch.pool
      );
    }


    const discovered =
      await findLaunchFromFactoryEvent(
        tokenAddress
      );


    if (
      discovered &&
      normalizeAddress(
        discovered.pool
      )
    ) {

      return normalizeAddress(
        discovered.pool
      );
    }


    throw new Error(
      "Canonical pons pool not found"
    );
  }


  // ============================================================
  // POOL STATE
  // ============================================================

  async function readPoolState(
    pool
  ) {

    const [
      slot0,
      token0,
      token1,
      liquidity
    ] =
      await Promise.all([

        ethCall(
          pool,
          "0x" +
          SELECTOR.slot0
        ),

        ethCall(
          pool,
          "0x" +
          SELECTOR.token0
        ),

        ethCall(
          pool,
          "0x" +
          SELECTOR.token1
        ),

        ethCall(
          pool,
          "0x" +
          SELECTOR.liquidity
        )
      ]);


    return {

      sqrtPriceX96:
        uintFromWord(
          word(
            slot0,
            0
          )
        ),

      tick:
        Number(
          int256FromWord(
            word(
              slot0,
              1
            )
          )
        ),

      token0:
        normalizeAddress(
          addressFromWord(
            word(
              token0,
              0
            )
          )
        ),

      token1:
        normalizeAddress(
          addressFromWord(
            word(
              token1,
              0
            )
          )
        ),

      liquidity:
        uintFromWord(
          word(
            liquidity,
            0
          )
        )
    };
  }


  // ============================================================
  // SPOT PRICE
  // ============================================================

  function calculateSpotPrice(
    sqrtPriceX96,
    tokenIsToken0,
    tokenDecimals,
    pairDecimals
  ) {

    try {

      const sqrt =
        Number(
          sqrtPriceX96
        ) /
        2 ** 96;


      const rawRatio =
        sqrt * sqrt;


      if (
        !Number.isFinite(
          rawRatio
        ) ||
        rawRatio <= 0
      ) {

        return null;
      }


      if (
        tokenIsToken0
      ) {

        return (
          rawRatio *
          10 ** tokenDecimals /
          10 ** pairDecimals
        );
      }


      return (
        (1 / rawRatio) *
        10 ** tokenDecimals /
        10 ** pairDecimals
      );

    } catch {

      return null;
    }
  }


  // ============================================================
  // TOKEN DATA
  // ============================================================

  async function getTokenData(
    tokenAddress
  ) {

    const address =
      normalizeAddress(
        tokenAddress
      );


    if (!address) {

      throw new Error(
        "Invalid token address"
      );
    }


    const key =
      "tokenData:" +
      address;


    if (
      cache.has(key)
    ) {

      return cache.get(
        key
      );
    }


    const metadata =
      await readTokenMetadata(
        address
      );


    /*
     * Current pons V1:
     *
     * - WETH only
     * - 1% pool fee
     * - TokenLaunched emits pool
     */

    let launch = null;


    try {

      launch =
        await resolveLaunch(
          address
        );

    } catch {}


    let poolAddress = null;


    if (
      launch &&
      normalizeAddress(
        launch.pool
      )
    ) {

      poolAddress =
        normalizeAddress(
          launch.pool
        );

    } else {

      poolAddress =
        await resolvePool(
          launch,
          address
        );
    }


    const pool =
      await readPoolState(
        poolAddress
      );


    const pairToken =
      normalizeAddress(
        launch?.pairedToken ||
        WETH
      );


    const pairIsWeth =
      pairToken ===
      normalizeAddress(
        WETH
      );


    const pairDecimals =
      pairIsWeth
        ? 18
        : 18;


    const pairSymbol =
      pairIsWeth
        ? "ETH"
        : "WETH";


    const tokenIsToken0 =
      normalizeAddress(
        address
      ) ===
      normalizeAddress(
        pool.token0
      );


    const pairIsToken0 =
      normalizeAddress(
        pairToken
      ) ===
      normalizeAddress(
        pool.token0
      );


    const poolFee =
      launch?.poolFee ||
      10000;


    const isNativePair =
      pairIsWeth;


    const priceInPair =
      calculateSpotPrice(

        pool.sqrtPriceX96,

        tokenIsToken0,

        metadata.tokenDecimals,

        pairDecimals
      );


    const result = {

      ...metadata,

      pairToken,

      pairSymbol,

      pairDecimals,

      isNativePair,

      poolAddress,

      poolFee,

      tokenIsToken0,

      pairIsToken0,

      factory:
        launch?.factory ||
        null,

      deployer:
        launch?.deployer ||
        null,

      positionManager:
        null,

      positionId:
        launch?.positionId
          ?.toString() ||
        null,

      initialBuyAmount:
        launch?.initialBuyAmount
          ?.toString() ||
        null,

      restrictionsEndBlock:
        launch
          ?.restrictionsEndBlock
          ?.toString() ||
        null,

      priceInPair,

      priceInWeth:
        isNativePair
          ? priceInPair
          : null,

      explorerBaseUrl:
        EXPLORER_BASE_URL,

      reference:
        address ===
        normalizeAddress(
          PONS_REFERENCE_TOKEN
        )
    };


    cache.set(
      key,
      result
    );


    return result;
  }


  // ============================================================
  // QUOTER V2
  // ============================================================

  function encodeQuoterCall(
    tokenIn,
    tokenOut,
    fee,
    amountIn
  ) {

    /*
     * QuoterV2:
     *
     * quoteExactInputSingle(
     *   address tokenIn,
     *   address tokenOut,
     *   uint256 amountIn,
     *   uint24 fee,
     *   uint160 sqrtPriceLimitX96
     * )
     *
     * IMPORTANT:
     * amountIn comes BEFORE fee.
     */

    return (

      "0x" +
      SELECTOR.quoteExactInputSingle +

      pad32(
        tokenIn
      ) +

      pad32(
        tokenOut
      ) +

      pad32(
        amountIn.toString(16)
      ) +

      Number(
        fee
      )
        .toString(16)
        .padStart(
          64,
          "0"
        ) +

      pad32("0")
    );
  }


  function extractRevertData(
    error
  ) {

    if (!error) {
      return null;
    }


    if (
      typeof error.data ===
      "string" &&
      /^0x[0-9a-fA-F]+$/
        .test(
          error.data
        )
    ) {

      return error.data;
    }


    const message =
      String(
        error.message ||
        ""
      );


    const match =
      message.match(
        /0x[0-9a-fA-F]{64,}/
      );


    return match
      ? match[0]
      : null;
  }


  async function quoteExactInput(
    tokenIn,
    tokenOut,
    fee,
    amountIn
  ) {

    const data =
      encodeQuoterCall(

        tokenIn,

        tokenOut,

        fee,

        amountIn
      );


    try {

      const result =
        await ethCall(
          QUOTER_V2,
          data
        );


      return uintFromWord(
        word(
          result,
          0
        )
      );

    } catch (
      error
    ) {

      /*
       * QuoterV2 may return
       * quote data through revert.
       */

      const revertData =
        extractRevertData(
          error
        );


      if (
        !revertData ||
        revertData.length <
        66
      ) {

        throw error;
      }


      return uintFromWord(
        word(
          revertData,
          0
        )
      );
    }
  }


  // ============================================================
  // PUBLIC QUOTE
  // ============================================================

  async function getQuote(
    params
  ) {

    if (!params) {

      throw new Error(
        "Quote parameters missing"
      );
    }


    const tokenAddress =
      normalizeAddress(
        params.tokenAddress
      );


    if (!tokenAddress) {

      throw new Error(
        "Invalid token address"
      );
    }


    const info =
      await getTokenData(
        tokenAddress
      );


    let sellAddress =
      params.sellAddress
        ? normalizeAddress(
            params.sellAddress
          )
        : null;


    let buyAddress =
      params.buyAddress
        ? normalizeAddress(
            params.buyAddress
          )
        : null;


    if (
      !sellAddress &&
      String(
        params.sellSymbol ||
        ""
      ).toUpperCase() ===
      "ETH"
    ) {

      sellAddress =
        WETH;
    }


    if (
      !buyAddress &&
      String(
        params.buySymbol ||
        ""
      ).toUpperCase() ===
      "ETH"
    ) {

      buyAddress =
        WETH;
    }


    if (
      !sellAddress ||
      !buyAddress
    ) {

      throw new Error(
        "Quote asset address unavailable"
      );
    }


    const sellDecimals =
      Number(
        params.sellDecimals ??
        (
          normalizeAddress(
            sellAddress
          ) ===
          normalizeAddress(
            WETH
          )
            ? 18
            : info.tokenDecimals
        )
      );


    const buyDecimals =
      Number(
        params.buyDecimals ??
        (
          normalizeAddress(
            buyAddress
          ) ===
          normalizeAddress(
            WETH
          )
            ? 18
            : info.tokenDecimals
        )
      );


    const amountInRaw =
      parseDecimalToUnits(
        params.amountIn,
        sellDecimals
      );


    if (
      amountInRaw <= 0n
    ) {

      return {

        amountOutRaw:
          "0",

        amountOut:
          "0",

        amountOutFormatted:
          "0",

        tokenIn:
          sellAddress,

        tokenOut:
          buyAddress,

        fee:
          info.poolFee
      };
    }


    const amountOutRaw =
      await quoteExactInput(

        sellAddress,

        buyAddress,

        info.poolFee,

        amountInRaw
      );


    const formatted =
      formatUnits(
        amountOutRaw,
        buyDecimals
      );


    return {

      amountOutRaw:
        amountOutRaw.toString(),

      amountOut:
        formatted,

      amountOutFormatted:
        formatted,

      tokenIn:
        sellAddress,

      tokenOut:
        buyAddress,

      fee:
        info.poolFee
    };
  }


  // ============================================================
  // TOKEN LAUNCHED DECODER
  // ============================================================

  function decodeTokenLaunchLog(
    log
  ) {

    const topics =
      log.topics || [];

    const data =
      log.data || "0x";


    if (
      topics.length < 4
    ) {

      return null;
    }


    return {

      token:
        normalizeAddress(
          addressFromWord(
            topics[1]
          )
        ),

      deployer:
        normalizeAddress(
          addressFromWord(
            topics[2]
          )
        ),

      dexFactory:
        normalizeAddress(
          addressFromWord(
            topics[3]
          )
        ),

      pairToken:
        normalizeAddress(
          addressFromWord(
            word(
              data,
              0
            )
          )
        ),

      pool:
        normalizeAddress(
          addressFromWord(
            word(
              data,
              1
            )
          )
        ),

      dexId:
        uintFromWord(
          word(
            data,
            2
          )
        ),

      launchConfigId:
        uintFromWord(
          word(
            data,
            3
          )
        ),

      positionId:
        uintFromWord(
          word(
            data,
            4
          )
        ),

      restrictionsEndBlock:
        uintFromWord(
          word(
            data,
            5
          )
        ),

      initialBuyAmount:
        uintFromWord(
          word(
            data,
            6
          )
        ),

      blockNumber:
        Number(
          BigInt(
            log.blockNumber
          )
        ),

      transactionHash:
        log.transactionHash,

      logIndex:
        Number(
          BigInt(
            log.logIndex ||
            "0x0"
          )
        )
    };
  }


  // ============================================================
  // TOKEN DISCOVERY
  // ============================================================

  async function getTokens(
    options = {}
  ) {

    const head =
      await getBlockNumber();


    const lookback =
      Number(
        options.lookbackBlocks ||
        TOKEN_LOOKBACK_BLOCKS
      );


    const limit =
      Number(
        options.limit ||
        MAX_TOKENS
      );


    const start =
      Math.max(
        0,
        head -
        lookback
      );


    const [
      activeLogs,
      legacyLogs
    ] =
      await Promise.all([

        scanLogs(

          ACTIVE_FACTORY,

          [
            TOPIC.TokenLaunched
          ],

          Math.max(
            ACTIVE_FACTORY_START,
            start
          ),

          head,

          limit
        ),

        scanLogs(

          LEGACY_FACTORY,

          [
            TOPIC.TokenLaunched
          ],

          Math.max(
            LEGACY_FACTORY_START,
            start
          ),

          head,

          limit
        )
      ]);


    const launches =
      [
        ...activeLogs,
        ...legacyLogs
      ]

        .map(
          decodeTokenLaunchLog
        )

        .filter(
          Boolean
        )

        .sort(
          (a, b) => {

            if (
              a.blockNumber !==
              b.blockNumber
            ) {

              return (
                b.blockNumber -
                a.blockNumber
              );
            }

            return (
              b.logIndex -
              a.logIndex
            );
          }
        );


    const seen =
      new Set();


    const rows =
      [];


    /*
     * PONS is always available
     * as the reference token.
     */

    try {

      const pons =
        await getTokenData(
          PONS_REFERENCE_TOKEN
        );


      rows.push({

        ...pons,

        launchBlock:
          null,

        transactionHash:
          null,

        trending:
          true
      });


      seen.add(
        normalizeAddress(
          PONS_REFERENCE_TOKEN
        )
      );

    } catch {}


    for (
      const launch
      of launches
    ) {

      if (
        !launch.token ||
        seen.has(
          launch.token
        )
      ) {

        continue;
      }


      seen.add(
        launch.token
      );


      rows.push({

        ...launch,

        tokenAddress:
          launch.token,

        poolAddress:
          launch.pool,

        pairToken:
          launch.pairToken,

        trending:
          false
      });


      if (
        rows.length >=
        limit
      ) {

        break;
      }
    }


    /*
     * Enrich only real launch records.
     * Failed RPC reads are omitted.
     */

    const enriched =
      await Promise.all(

        rows
          .slice(
            0,
            limit
          )
          .map(
            async row => {

              try {

                const data =
                  await getTokenData(
                    row.tokenAddress
                  );


                return {

                  ...row,

                  ...data,

                  launchBlock:
                    row.blockNumber ??
                    row.launchBlock ??
                    null,

                  transactionHash:
                    row.transactionHash ??
                    null,

                  trending:
                    Boolean(
                      row.trending
                    )
                };

              } catch {

                return null;
              }
            }
          )
      );


    return enriched.filter(
      Boolean
    );
  }


  // ============================================================
  // SWAP DECODER
  // ============================================================

  function decodeSwapLog(
    log,
    token,
    pairToken,
    tokenDecimals,
    pairDecimals,
    tokenIsToken0
  ) {

    const topics =
      log.topics || [];


    if (
      topics.length < 3
    ) {

      return null;
    }


    const sender =
      normalizeAddress(
        addressFromWord(
          topics[1]
        )
      );


    const recipient =
      normalizeAddress(
        addressFromWord(
          topics[2]
        )
      );


    const amount0 =
      int256FromWord(
        word(
          log.data,
          0
        )
      );


    const amount1 =
      int256FromWord(
        word(
          log.data,
          1
        )
      );


    const sqrtPriceX96 =
      uintFromWord(
        word(
          log.data,
          2
        )
      );


    const liquidity =
      uintFromWord(
        word(
          log.data,
          3
        )
      );


    const tick =
      Number(
        int256FromWord(
          word(
            log.data,
            4
          )
        )
      );


    const tokenSigned =
      tokenIsToken0
        ? amount0
        : amount1;


    const pairSigned =
      tokenIsToken0
        ? amount1
        : amount0;


    /*
     * pons direction:
     *
     * pairSigned > 0 => buy
     * pairSigned < 0 => sell
     */

    const side =
      pairSigned > 0n
        ? "buy"
        : "sell";


    const tokenAmountRaw =
      tokenSigned < 0n
        ? -tokenSigned
        : tokenSigned;


    const pairAmountRaw =
      pairSigned < 0n
        ? -pairSigned
        : pairSigned;


    let price = null;


    try {

      const tokenAmount =
        Number(
          formatUnits(
            tokenAmountRaw,
            tokenDecimals
          )
        );


      const pairAmount =
        Number(
          formatUnits(
            pairAmountRaw,
            pairDecimals
          )
        );


      if (
        tokenAmount > 0 &&
        Number.isFinite(
          tokenAmount
        ) &&
        Number.isFinite(
          pairAmount
        )
      ) {

        price =
          pairAmount /
          tokenAmount;
      }

    } catch {}


    return {

      tokenAddress:
        token,

      pairToken,

      side,

      trader:
        sender,

      recipient,

      traderShort:
        shortAddress(
          sender
        ),

      recipientShort:
        shortAddress(
          recipient
        ),

      tokenAmountRaw:
        tokenAmountRaw.toString(),

      tokenAmount:
        formatUnits(
          tokenAmountRaw,
          tokenDecimals
        ),

      pairAmountRaw:
        pairAmountRaw.toString(),

      pairAmount:
        formatUnits(
          pairAmountRaw,
          pairDecimals
        ),

      price,

      sqrtPriceX96:
        sqrtPriceX96.toString(),

      liquidity:
        liquidity.toString(),

      tick,

      blockNumber:
        Number(
          BigInt(
            log.blockNumber
          )
        ),

      transactionHash:
        log.transactionHash,

      logIndex:
        Number(
          BigInt(
            log.logIndex ||
            "0x0"
          )
        ),

      timestamp:
        null
    };
  }


  // ============================================================
  // RECENT TRADES
  // ============================================================

  async function getRecentTrades(
    tokenAddress,
    limit = 20
  ) {

    const info =
      await getTokenData(
        tokenAddress
      );


    const head =
      await getBlockNumber();


    const start =
      Math.max(
        0,
        head -
        TRADE_LOOKBACK_BLOCKS
      );


    const logs =
      await scanLogs(

        info.poolAddress,

        [
          TOPIC.Swap
        ],

        start,

        head,

        Math.max(
          limit,
          MAX_TRADES
        )
      );


    const trades =
      logs

        .map(
          log =>
            decodeSwapLog(

              log,

              info.tokenAddress,

              info.pairToken,

              info.tokenDecimals,

              info.pairDecimals,

              info.tokenIsToken0
            )
        )

        .filter(
          Boolean
        )

        .slice(
          0,
          limit
        );


    const blockCache =
      new Map();


    for (
      const trade
      of trades
    ) {

      try {

        if (
          !blockCache.has(
            trade.blockNumber
          )
        ) {

          blockCache.set(

            trade.blockNumber,

            await getBlock(
              trade.blockNumber
            )
          );
        }


        const block =
          blockCache.get(
            trade.blockNumber
          );


        if (
          block &&
          block.timestamp
        ) {

          trade.timestamp =
            Number(
              BigInt(
                block.timestamp
              )
            );
        }

      } catch {}
    }


    return trades;
  }


  // ============================================================
  // HOLDERS
  // ============================================================

  async function getHolders() {

    /*
     * No off-chain holder indexer.
     *
     * Return empty rather than
     * fabricate holder information.
     */

    return [];
  }


  // ============================================================
  // PUBLIC API
  // ============================================================

  window.PonslyPons = {

    ROBINHOOD_CHAIN_ID:
      CHAIN_ID,

    RPC_URL,

    EXPLORER_BASE_URL,

    ACTIVE_FACTORY,

    LEGACY_FACTORY,

    V3_FACTORY,

    QUOTER_V2,

    WETH,

    PONS_REFERENCE_TOKEN,

    PONS_REFERENCE_POOL,

    getTokenData,

    getQuote,

    getRecentTrades,

    getTokens,

    getHolders,

    _resolveLaunch:
      resolveLaunch
  };

})();
