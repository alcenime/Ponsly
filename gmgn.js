/**
 * js/gmgn.js
 * -----------------------------------------------------------------------
 * Ponsly x GMGN — isolated, read-only chart embed integration.
 *
 * Scope of this file (and nothing more):
 *   - Build a GMGN K-line/chart embed URL for a given token address.
 *   - Mount/unmount that chart as an <iframe> inside a given container.
 *
 * Explicitly OUT of scope here:
 *   - No demo/fake candles, OHLCV, or transactions of any kind.
 *   - No scraping of gmgn.cc / gmgn.ai pages.
 *   - No calls to undocumented/private GMGN APIs.
 *   - No hardcoded token address (address always comes from the caller).
 *   - No wallet connection, account/chain access, balances, approvals,
 *     or transactions. Wallet/swap logic lives entirely in wallet.js /
 *     swap.js and is never touched or imported here.
 *
 * This file does not read window.location on its own — the caller
 * (token.html) is responsible for resolving the token address from the
 * URL and passing it in explicitly. That keeps this module reusable and
 * avoids duplicating token-resolution logic.
 * -----------------------------------------------------------------------
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------
  //
  // GMGN publishes a documented K-line/chart embed at:
  //   https://www.gmgn.cc/kline/{chain}/{tokenAddress}
  //
  // The {chain} segment must be one of GMGN's own officially documented
  // chain identifiers (their public docs list chains such as sol, eth,
  // bsc, base, tron, etc. for this endpoint).
  //
  // As of writing, GMGN's public documentation does NOT list an
  // identifier for "Robinhood Chain" (chainId 4663 / 0x1237). Guessing a
  // slug (e.g. "robinhood", "rbh", "4663") would silently point at a
  // chart for a chain that isn't actually Robinhood Chain, or at a
  // 404/error inside the iframe — both are worse than a clear
  // "Chart unavailable" state.
  //
  // DO NOT set this until GMGN's official docs explicitly confirm a
  // Robinhood Chain identifier for the K-line embed endpoint. When they
  // do, set it here as a plain string (e.g. 'robinhood') and nothing
  // else in this file needs to change.
  var GMGN_CHAIN = null; // <-- intentionally unset; see comment above.

  var GMGN_KLINE_BASE = 'https://www.gmgn.cc/kline';

  var EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  function isValidAddress(address) {
    return typeof address === 'string' && EVM_ADDRESS_RE.test(address.trim());
  }

  function renderUnavailable(container) {
    if (!container) return;
    container.innerHTML = '';
    var msg = document.createElement('div');
    msg.className = 'gmgn-chart-unavailable';
    msg.textContent = 'Chart unavailable';
    container.appendChild(msg);
  }

  function findExistingFrame(container) {
    if (!container || !container.querySelector) return null;
    return container.querySelector('iframe[data-gmgn-chart="1"]');
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Build the official GMGN K-line embed URL for a token.
   * Returns null if the address is invalid or the Robinhood Chain
   * identifier has not been officially verified with GMGN.
   *
   * @param {string} tokenAddress
   * @returns {string|null}
   */
  function getChartUrl(tokenAddress) {
    if (!isValidAddress(tokenAddress)) {
      console.warn('Ponsly: invalid token address passed to getChartUrl().');
      return null;
    }

    if (!GMGN_CHAIN) {
      console.warn(
        'Ponsly: GMGN Robinhood Chain chart embed identifier is not verified.'
      );
      return null;
    }

    return (
      GMGN_KLINE_BASE +
      '/' +
      encodeURIComponent(GMGN_CHAIN) +
      '/' +
      tokenAddress.trim()
    );
  }

  /**
   * Mount the GMGN chart embed for a token into a container element.
   * Renders "Chart unavailable" if no verified chart URL can be built.
   *
   * @param {string} tokenAddress
   * @param {HTMLElement} container
   */
  function mountChart(tokenAddress, container) {
    if (!container || !(container instanceof HTMLElement)) {
      console.warn('Ponsly: mountChart() requires a valid container element.');
      return;
    }

    // Always start clean — no stale iframe/content left behind.
    unmountChart(container);

    var url = getChartUrl(tokenAddress);
    if (!url) {
      renderUnavailable(container);
      return;
    }

    var iframe = document.createElement('iframe');
    iframe.setAttribute('data-gmgn-chart', '1');
    iframe.src = url;
    iframe.width = '100%';
    iframe.height = '420';
    iframe.style.width = '100%';
    iframe.style.height = '420px';
    iframe.style.border = '0';
    iframe.loading = 'lazy';
    iframe.setAttribute('allow', 'fullscreen');
    iframe.setAttribute('title', 'GMGN chart');

    container.innerHTML = '';
    container.appendChild(iframe);
  }

  /**
   * Remove any mounted GMGN chart iframe from a container and clear it.
   * Safe to call multiple times / when nothing is mounted.
   *
   * @param {HTMLElement} container
   */
  function unmountChart(container) {
    if (!container || !(container instanceof HTMLElement)) return;

    var frame = findExistingFrame(container);
    if (frame && frame.parentNode) {
      frame.parentNode.removeChild(frame);
    }

    container.innerHTML = '';
  }

  // ---------------------------------------------------------------------
  // Expose
  // ---------------------------------------------------------------------

  window.PonslyGMGN = {
    getChartUrl: getChartUrl,
    mountChart: mountChart,
    unmountChart: unmountChart
  };
})();
