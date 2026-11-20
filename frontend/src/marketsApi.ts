// Live market data for the Markets page.
//   Prices: Yahoo Finance chart API via the /api/yahoo proxy (see vite.config.ts), for
//           stocks and crypto (BTC-USD, ETH-USD): price, day change, ~6 months of daily closes
//   Crypto: CoinGecko public API adds market cap and 24h USD volume (one optional call;
//           its free tier is rate-limited, so prices never depend on it)
//   Odds:   Polymarket public search (called directly)
// Each asset loads independently, so one failing source doesn't blank the page.
// useMarketData() refreshes every 2 minutes and keeps the last good numbers if a refresh fails.
import { useCallback, useEffect, useRef, useState } from "react";
import { WATCHLIST, type AssetData, type Point, type Quote, type RelatedMarket } from "./markets";

const COINGECKO = "https://api.coingecko.com/api/v3";
const YAHOO = "/api/yahoo";
const POLYMARKET = "https://gamma-api.polymarket.com";
const REFRESH_MS = 120_000;

const FRESH_MS = 60_000; // reuse data younger than this across page visits and reloads
const CACHE_KEY = "allowance-markets-v1";

async function getJSON<T>(url: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal });
  if (r.status === 429) throw new Error("the price service is busy, try again in a minute");
  if (!r.ok) throw new Error(`${r.status} ${r.statusText || "error"}`);
  return r.json() as Promise<T>;
}

// Last good data, shared across mounts (memory) and reloads (sessionStorage), so switching
// pages or refreshing doesn't refetch and run into the free APIs' rate limits.
type Cache = { data: Record<string, AssetData>; at: number };
let memory: Cache | null = null;
function readCache(): Cache | null {
  if (memory) return memory;
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (raw) memory = JSON.parse(raw) as Cache;
  } catch {
    /* storage unavailable: just fetch */
  }
  return memory;
}
function writeCache(c: Cache) {
  memory = c;
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* storage full or blocked: memory copy still works */
  }
}

// ---------------------------------------------------------------------------
// Crypto extras (CoinGecko): market cap, 24h USD volume and 24h change, in one call.
// Optional: if it fails (e.g. the free tier's rate limit), prices still show from Yahoo.
// ---------------------------------------------------------------------------
type CgMarket = { id: string; market_cap: number; total_volume: number; price_change_percentage_24h: number };

async function cryptoExtras(ids: string[], signal: AbortSignal): Promise<Record<string, CgMarket>> {
  const rows = await getJSON<CgMarket[]>(`${COINGECKO}/coins/markets?vs_currency=usd&ids=${ids.join(",")}`, signal);
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

// ---------------------------------------------------------------------------
// Stocks (Yahoo Finance)
// ---------------------------------------------------------------------------
type YahooChart = {
  chart: {
    result:
      | {
          meta: {
            regularMarketPrice: number;
            regularMarketChangePercent?: number;
            previousClose?: number;
            regularMarketVolume?: number;
            fiftyTwoWeekHigh?: number;
            fiftyTwoWeekLow?: number;
          };
          timestamp: number[];
          indicators: { quote: { close: (number | null)[]; volume: (number | null)[] }[] };
        }[]
      | null;
    error: { description?: string } | null;
  };
};

async function stockQuote(symbol: string, signal: AbortSignal): Promise<Quote> {
  const j = await getJSON<YahooChart>(`${YAHOO}/v8/finance/chart/${symbol}?range=6mo&interval=1d`, signal);
  const r = j.chart.result?.[0];
  if (!r) throw new Error(j.chart.error?.description || "no data");
  const q = r.indicators.quote[0];
  const series: Point[] = r.timestamp
    .map((ts, i) => ({ t: ts * 1000, price: q.close[i] ?? NaN, volume: q.volume[i] ?? 0 }))
    .filter((p) => Number.isFinite(p.price));
  const m = r.meta;
  const price = m.regularMarketPrice;
  // Previous close: the last daily close before today's.
  const last = series[series.length - 1];
  const prevClose = m.previousClose ?? (Math.abs(last.price - price) < 1e-9 ? series[series.length - 2]?.price : last.price);
  const dayChangePct = m.regularMarketChangePercent ?? (prevClose ? ((price - prevClose) / prevClose) * 100 : 0);
  return {
    price,
    dayChangePct,
    series,
    volume: m.regularMarketVolume ?? last.volume,
    prevClose,
    high52: m.fiftyTwoWeekHigh,
    low52: m.fiftyTwoWeekLow,
  };
}

// ---------------------------------------------------------------------------
// Prediction markets (Polymarket)
// ---------------------------------------------------------------------------
type PmMarket = { question: string; outcomePrices?: string; closed?: boolean; active?: boolean; volumeNum?: number; volume?: string };
type PmSearch = { events?: { slug: string; markets?: PmMarket[] }[] };

async function relatedMarkets(query: string, signal: AbortSignal): Promise<RelatedMarket[]> {
  const j = await getJSON<PmSearch>(
    `${POLYMARKET}/public-search?q=${encodeURIComponent(query)}&limit_per_type=8&events_status=active`,
    signal,
  );
  const found: RelatedMarket[] = [];
  for (const e of j.events ?? []) {
    for (const m of e.markets ?? []) {
      if (m.closed || m.active === false || !m.outcomePrices) continue;
      let yes = NaN;
      try {
        yes = parseFloat(JSON.parse(m.outcomePrices)[0]);
      } catch {
        continue;
      }
      if (!Number.isFinite(yes)) continue;
      found.push({ question: m.question, yesPrice: yes, url: `https://polymarket.com/event/${e.slug}`, volume: m.volumeNum ?? parseFloat(m.volume ?? "0") });
    }
  }
  // Prefer markets that are still in play (not already ~0% or ~100%), then the most traded.
  const live = found.filter((m) => m.yesPrice > 0.03 && m.yesPrice < 0.97);
  return (live.length >= 2 ? live : found).sort((a, b) => b.volume - a.volume).slice(0, 3);
}

// ---------------------------------------------------------------------------
// Load everything
// ---------------------------------------------------------------------------
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function loadAll(signal: AbortSignal): Promise<Record<string, AssetData>> {
  const cgIds = WATCHLIST.flatMap((a) => (a.source.kind === "crypto" ? [a.source.coingeckoId] : []));
  const extrasP = cryptoExtras(cgIds, signal).catch(() => ({}) as Record<string, CgMarket>);

  const entries = await Promise.all(
    WATCHLIST.map(async (a): Promise<[string, AssetData]> => {
      const [quote, related] = await Promise.allSettled([
        stockQuote(a.source.yahoo, signal).then(async (q) => {
          if (a.source.kind !== "crypto") return q;
          // Crypto: add market cap and 24h USD volume / change when CoinGecko answered.
          const x = (await extrasP)[a.source.coingeckoId];
          return x
            ? { ...q, marketCap: x.market_cap, volume: x.total_volume, dayChangePct: x.price_change_percentage_24h, prevClose: undefined }
            : q;
        }),
        relatedMarkets(a.search, signal),
      ]);
      return [
        a.symbol,
        {
          quote: quote.status === "fulfilled" ? quote.value : undefined,
          quoteError: quote.status === "rejected" ? message(quote.reason) : undefined,
          related: related.status === "fulfilled" ? related.value : undefined,
          relatedError: related.status === "rejected" ? message(related.reason) : undefined,
        },
      ];
    }),
  );
  return Object.fromEntries(entries);
}

export function useMarketData() {
  const [data, setData] = useState<Record<string, AssetData>>(() => readCache()?.data ?? {});
  const [updatedAt, setUpdatedAt] = useState<number | null>(() => readCache()?.at ?? null);
  const [loading, setLoading] = useState(() => !readCache());
  const ctrlRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    try {
      const next = await loadAll(ctrl.signal);
      if (ctrl.signal.aborted) return;
      // Keep the last good numbers when a refresh fails for an asset.
      const prev = readCache()?.data ?? {};
      const merged: Record<string, AssetData> = {};
      for (const [sym, d] of Object.entries(next)) {
        merged[sym] = {
          quote: d.quote ?? prev[sym]?.quote,
          quoteError: d.quote ? undefined : d.quoteError,
          related: d.related ?? prev[sym]?.related,
          relatedError: d.related ? undefined : d.relatedError,
        };
      }
      const at = Date.now();
      writeCache({ data: merged, at });
      setData(merged);
      setUpdatedAt(at);
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetch now unless the cached data is still fresh; then keep refreshing on a timer.
    const cached = readCache();
    const age = cached ? Date.now() - cached.at : Infinity;
    let interval = 0;
    const first = window.setTimeout(
      () => {
        refresh();
        interval = window.setInterval(refresh, REFRESH_MS);
      },
      age < FRESH_MS ? REFRESH_MS - age : 0,
    );
    return () => {
      window.clearTimeout(first);
      window.clearInterval(interval);
      ctrlRef.current?.abort();
    };
  }, [refresh]);

  return { data, loading, updatedAt, refresh };
}
