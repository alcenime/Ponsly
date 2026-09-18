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

   CHANGE FROM PREVIOUS VERSION: the loading state now shows live
   scan progress ("Scanning block X -> Y...") instead of a static
   "Loading on-chain chart..." message, so a stuck/slow scan is
   visible on-screen instead of only in the browser console.
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

    let el = container.querySelector('[data-pons-state="1"]');

    if (!el) {
      // Only wipe the chart (not an existing state node) so repeated
      // progress updates don't flicker/rebuild the DOM node each time.
      const chart = container.querySelector('[data-pons-chart="1"]');
      if (chart) chart.remove();

      el = document.createElement("div");
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
        "box-sizing:border-box",
        "white-space:pre-line"
      ].join(";");

      container.appendChild(el);
    }

    el.textContent = message;
  }

  function formatNum(n) {
    try {
      return Number(n).toLocaleString("en-US");
    } catch {
      return String(n);
    }
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

    // Visible progress so a slow/stuck scan shows on screen instead of
    // silently sitting on "Loading..." forever. Wrapped in try/catch so a
    // bug in the progress UI itself can never break the actual chart load.
    const startedAt = Date.now();
    const onProgress = (p) => {
      try {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
        renderState(
          container,
          `Scanning on-chain history\u2026\n` +
            `block ${formatNum(p.from)} \u2192 ${formatNum(p.to)} of ${formatNum(p.end)}\n` +
            `${formatNum(p.foundSoFar)} swaps found \u00b7 ${elapsed}s elapsed`
        );
      } catch (e) {
        /* ignore progress-rendering errors */
      }
    };

    let candles;
    try {
      candles = await window.PonslyKline.getSwapCandles({
        poolAddress,
        baseToken,
        fromBlock: options.fromBlock,
        toBlock: options.toBlock,
        intervalSeconds,
        onProgress: (p) => {
          onProgress(p);
          if (typeof options.onProgress === "function") options.onProgress(p);
        }
      });
    } catch (error) {
      console.warn("[PonslyChart] getSwapCandles failed:", error);
      renderState(
        container,
        "Could not load on-chain chart data.\n" + (error && error.message ? error.message : "")
      );
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
