/* Ponsly — GMGN read-only chart adapter
 * No GMGN private API, no scraping, no trading.
 *
 * GMGN documented K-line embed:
 * https://www.gmgn.cc/kline/{chain}/{token CA}
 *
 * Robinhood token pages exist on GMGN, but the public K-line
 * documentation does not explicitly document the Robinhood
 * embed slug. Therefore we do NOT invent a chain slug here.
 */

(function () {
  "use strict";

  /*
   * IMPORTANT:
   *
   * Keep this null until the Robinhood K-line embed slug
   * is officially verified.
   *
   * Do NOT blindly change this to "robinhood".
   */
  const GMGN_CHAIN = null;

  const GMGN_KLINE_BASE = "https://www.gmgn.cc/kline";

  // ============================================================
  // ADDRESS HELPERS
  // ============================================================

  function isAddress(value) {
    return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
  }

  function normalizeAddress(value) {
    if (!isAddress(value)) return null;

    return "0x" + value.slice(2).toLowerCase();
  }

  // ============================================================
  // CHART URL
  // ============================================================

  function getChartUrl(tokenAddress, options = {}) {
    const address = normalizeAddress(tokenAddress);

    if (!address) {
      return null;
    }

    /*
     * We intentionally refuse to construct an undocumented
     * Robinhood embed URL.
     */
    if (!GMGN_CHAIN) {
      return null;
    }

    const url = new URL(
      `${GMGN_KLINE_BASE}/${encodeURIComponent(GMGN_CHAIN)}/${address}`
    );

    // ----------------------------------------------------------
    // Documented GMGN K-line parameters
    // ----------------------------------------------------------

    if (
      options.theme === "light" ||
      options.theme === "dark"
    ) {
      url.searchParams.set("theme", options.theme);
    }

    const validIntervals = new Set([
      "1S",
      "1",
      "5",
      "15",
      "60",
      "240",
      "720",
      "1D"
    ]);

    if (validIntervals.has(options.interval)) {
      url.searchParams.set(
        "interval",
        options.interval
      );
    }

    return url.toString();
  }

  // ============================================================
  // CLEAR CHART
  // ============================================================

  function clear(container) {
    if (!(container instanceof HTMLElement)) {
      return;
    }

    const chart = container.querySelector(
      '[data-gmgn-chart="1"]'
    );

    if (chart) {
      chart.remove();
    }

    const unavailable = container.querySelector(
      '[data-gmgn-unavailable="1"]'
    );

    if (unavailable) {
      unavailable.remove();
    }
  }

  // ============================================================
  // UNAVAILABLE STATE
  // ============================================================

  function renderUnavailable(container, message) {
    if (!(container instanceof HTMLElement)) {
      return;
    }

    clear(container);

    const state = document.createElement("div");

    state.dataset.gmgnUnavailable = "1";

    state.style.cssText = [
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

    state.textContent =
      message ||
      "GMGN chart unavailable.";

    container.appendChild(state);
  }

  // ============================================================
  // MOUNT CHART
  // ============================================================

  /*
   * Canonical signature:
   *
   * mountChart(tokenAddress, container, options)
   *
   * This matches token.html:
   *
   * PonslyGMGN.mountChart(
   *   info.tokenAddress,
   *   wrap
   * );
   */

  function mountChart(
    tokenAddress,
    container,
    options = {}
  ) {
    if (!(container instanceof HTMLElement)) {
      return false;
    }

    clear(container);

    const address =
      normalizeAddress(tokenAddress);

    if (!address) {
      renderUnavailable(
        container,
        "Invalid token address."
      );

      return false;
    }

    const url =
      getChartUrl(
        address,
        options
      );

    /*
     * No verified Robinhood embed route.
     *
     * Do NOT create a fake/custom chart.
     */
    if (!url) {
      renderUnavailable(
        container,
        "GMGN chart is currently unavailable."
      );

      return false;
    }

    // ==========================================================
    // GMGN IFRAME
    // ==========================================================

    const iframe =
      document.createElement("iframe");

    iframe.dataset.gmgnChart = "1";

    iframe.src = url;

    iframe.title =
      "GMGN chart";

    iframe.loading =
      "lazy";

    iframe.allowFullscreen =
      true;

    iframe.referrerPolicy =
      "strict-origin-when-cross-origin";

    iframe.style.cssText = [
      "display:block",
      "width:100%",
      "height:420px",
      "border:0",
      "background:transparent"
    ].join(";");

    container.appendChild(
      iframe
    );

    return true;
  }

  // ============================================================
  // UNMOUNT CHART
  // ============================================================

  function unmountChart(container) {
    if (!(container instanceof HTMLElement)) {
      return;
    }

    clear(container);
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  window.PonslyGMGN = {
    getChartUrl,
    mountChart,
    unmountChart,

    isConfigured: function () {
      return Boolean(GMGN_CHAIN);
    },

    chain: GMGN_CHAIN
  };

})();
