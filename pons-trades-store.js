/* =========================================================
   PONSLY — TRADES CACHE (SUPABASE)
   File: pons-trades-store.js

   This is ONLY the cache/index layer described in the Recent
   Trades spec: ONCHAIN → INDEXER → SUPABASE → PONSLY UI.

   This file is the "SUPABASE" box. It does NOT talk to the
   blockchain and does NOT know anything about CurveBuy/CurveSell
   or pool Swap events yet — that's the "INDEXER" box, added once
   the Pons V2 contract addresses/event signatures are known.

   Supabase remains a CACHE, not the source of truth: every row
   here is expected to have come from a real on-chain event first.
   This module never invents trade data.

   Requires the supabase-js UMD build loaded first:
     <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
     <script src="pons-trades-store.js"></script>

   Exposes: window.PonslyTradesStore
     - getCachedTrades(tokenAddress, limit)  -> Promise<Array<Row>>
     - getLastIndexedBlock(tokenAddress)     -> Promise<number|null>
     - saveTrades(trades)                    -> Promise<{ saved, error? }>
     - isConfigured()                        -> boolean
   ========================================================= */

(function () {
  "use strict";

  // Project URL + anon public key from Supabase → Project Settings → API Keys.
  // Safe to expose client-side: RLS policies on the `trades` table are what
  // actually control access (public read, public insert), not this key.
  const SUPABASE_URL = "https://coctunojdsbmygzteqmj.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNvY3R1bm9qZHNibXlnenRlcW1qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk3NDYyODMsImV4cCI6MjEwNTMyMjI4M30.IbbRraAdE1n8uN2GuVok368oLOscKJ2rcFmwHXLmu4s";

  let client = null;

  function getClient() {
    if (client) return client;
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      console.error(
        "[Ponsly] supabase-js not found — add the CDN <script> tag " +
        "BEFORE pons-trades-store.js in token.html."
      );
      return null;
    }
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return client;
  }

  /*
   * Reads the most recent cached trades for a token, newest first.
   * Returns [] on any failure — callers should treat that the same
   * as "no trades yet", never as a fatal error.
   */
  async function getCachedTrades(tokenAddress, limit = 50) {
    const supabase = getClient();
    if (!supabase || !tokenAddress) return [];

    const { data, error } = await supabase
      .from("trades")
      .select("*")
      .eq("token_address", String(tokenAddress).toLowerCase())
      .order("block_time", { ascending: false })
      .limit(limit);

    if (error) {
      console.warn("[Ponsly] getCachedTrades failed:", error.message);
      return [];
    }

    return data || [];
  }

  /*
   * Highest block_number already cached for a token — the indexer
   * uses this to know where to resume scanning from, instead of
   * re-scanning from genesis every page load.
   */
  async function getLastIndexedBlock(tokenAddress) {
    const supabase = getClient();
    if (!supabase || !tokenAddress) return null;

    const { data, error } = await supabase
      .from("trades")
      .select("block_number")
      .eq("token_address", String(tokenAddress).toLowerCase())
      .order("block_number", { ascending: false })
      .limit(1);

    if (error || !data || !data.length) return null;
    return data[0].block_number;
  }

  /*
   * Upserts newly-indexed on-chain trades into the cache. Expects
   * trades already decoded from real events — this function does
   * not fabricate or guess any field.
   *
   * Dedup key is (tx_hash, log_index) — matches the `unique(tx_hash,
   * log_index)` constraint on the trades table, so re-indexing the
   * same event twice is a no-op instead of a duplicate row.
   *
   * Expected shape per trade:
   *   {
   *     tokenAddress, txHash, logIndex, blockNumber,
   *     trader, side ('buy'|'sell'), tokenAmount, quoteAmount,
   *     price (optional), source ('curve'|'pool'), blockTime (ISO string)
   *   }
   */
  async function saveTrades(trades) {
    const supabase = getClient();
    if (!supabase || !Array.isArray(trades) || !trades.length) {
      return { saved: 0 };
    }

    const rows = trades.map(t => ({
      token_address: String(t.tokenAddress || "").toLowerCase(),
      tx_hash: t.txHash,
      log_index: t.logIndex,
      block_number: t.blockNumber,
      trader: t.trader,
      side: t.side,
      token_amount: t.tokenAmount,
      quote_amount: t.quoteAmount,
      price: t.price ?? null,
      source: t.source || "curve",
      block_time: t.blockTime
    }));

    const { data, error } = await supabase
      .from("trades")
      .upsert(rows, { onConflict: "tx_hash,log_index", ignoreDuplicates: true })
      .select();

    if (error) {
      console.warn("[Ponsly] saveTrades failed:", error.message);
      return { saved: 0, error: error.message };
    }

    return { saved: (data || []).length };
  }

  window.PonslyTradesStore = {
    getCachedTrades,
    getLastIndexedBlock,
    saveTrades,
    isConfigured: () => Boolean(getClient())
  };

  console.log("[Ponsly] pons-trades-store.js loaded (cache layer only — no on-chain indexer wired yet)");
})();
