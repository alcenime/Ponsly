/* =========================================================
   PONSLY — ON-CHAIN CHART RENDERER
   File: pons-chart.js

   Drop-in replacement for gmgn.js's mountChart/unmountChart
   shape — but instead of an iframe pointed at a GMGN endpoint
   that turned out not to exist, this draws real candles built
   from on-chain Swap events (pons-kline.js) with Lightweight
   Charts.

   LOAD ORDER (in your HTML, in this order):
     1. pons.js
     2. pons-kline.js
     3. <script src="https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
     4. pons-chart.js

   USAGE (replaces PonslyGMGN.mountChart(...)):
     PonslyChart.mountChart(tokenAddress, container, {
       poolAddress: tokenData.poolAddress,   // required
       baseToken: tokenAddress,              // optional, defaults to tokenAddress
       intervalSeconds: 60,                  // optional, default 60 (1m)
       fromBlock: 8991118,                   // optional, default 0 (scans everything)
     });

   `poolAddress` is required — this module has no GMGN backend
   to resolve token -> pool for you, so pass it from whatever
   already knows it (e.g. Ponsly.getTokenData(tokenAddress).poolAddress).
   ========================================================= */

(function () {
  "use strict";

  function clear(container) {
    if (!(container instanceof HTMLElement)) return;

    const chart = container.querySelector('[data-pons-chart="1"]');
    if (chart) chart.remove();

    const state = container.querySelector('[data-pons-state="1"]');
    if (state) state.remove();
  }

  function renderState(container, message) {
    if (!(container instanceof HTMLElement)) return;

    clear(container);

    const el = document.createElement("div");
    el.dataset.ponsState = "1";
    el.style.cssText = [
      "width:100%",
      "height:420px",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "font-size:13px",
      "line-height:1.5",
      "color:rgba(255,255,255,.45)",
      "background:transparent",
      "text-align:center",
      "padding:24px",
      "box-sizing:border-box"
    ].join(";");
    el.textContent = message;

    container.appendChild(el);
  }

  // container -> { chart, resizeHandler } — so unmountChart can clean up
  const activeCharts = new WeakMap();

  async function mountChart(tokenAddress, container, options = {}) {
    if (!(container instanceof HTMLElement)) return false;

    if (!window.PonslyKline) {
      renderState(container, "Chart engine (pons-kline.js) not loaded.");
      return false;
    }

    if (!window.LightweightCharts) {
      renderState(container, "Chart library failed to load.");
      return false;
    }

    const poolAddress = options.poolAddress;
    const baseToken = options.baseToken || tokenAddress;
    const intervalSeconds = options.intervalSeconds || 60;

    if (!poolAddress) {
      renderState(container, "No pool address provided for this token.");
      return false;
    }

    renderState(container, "Loading on-chain chart\u2026");

    let candles;
    try {
      candles = await window.PonslyKline.getSwapCandles({
        poolAddress,
        baseToken,
        fromBlock: options.fromBlock,
        toBlock: options.toBlock,
        intervalSeconds,
        onProgress: options.onProgress
      });
    } catch (error) {
      console.warn("[PonslyChart] getSwapCandles failed:", error);
      renderState(container, "Could not load on-chain chart data.");
      return false;
    }

    if (!candles || candles.length === 0) {
      renderState(container, "No swap history found for this pool yet.");
      return false;
    }

    clear(container);

    const chartEl = document.createElement("div");
    chartEl.dataset.ponsChart = "1";
    chartEl.style.cssText = "width:100%;height:420px;";
    container.appendChild(chartEl);

    const chart = window.LightweightCharts.createChart(chartEl, {
      width: chartEl.clientWidth,
      height: 420,
      layout: {
        background: { color: "transparent" },
        textColor: "rgba(255,255,255,.6)"
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,.06)" },
        horzLines: { color: "rgba(255,255,255,.06)" }
      },
      timeScale: { timeVisible: true, secondsVisible: false }
    });

    const series = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444"
    });

    series.setData(
      candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      }))
    );

    chart.timeScale().fitContent();

    const resizeHandler = () => {
      chart.applyOptions({ width: chartEl.clientWidth });
    };
    window.addEventListener("resize", resizeHandler);

    activeCharts.set(container, { chart, resizeHandler });

    return true;
  }

  function unmountChart(container) {
    const entry = activeCharts.get(container);

    if (entry) {
      window.removeEventListener("resize", entry.resizeHandler);
      entry.chart.remove();
      activeCharts.delete(container);
    }

    clear(container);
  }

  window.PonslyChart = {
    mountChart,
    unmountChart
  };
})();
