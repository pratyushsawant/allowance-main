/**
 * Read-only queries over the recorder's tables. Prices stay decimal strings; differences are
 * computed in integer units (6 decimals) and formatted back, never with floats.
 */
import type { DB } from "./db.ts";
import { formatBaseUnits, toBaseUnits } from "./units.ts";

const PRICE_DECIMALS = 6;
const ACTIVE_WINDOW_MS = 15 * 60_000;

export interface ContractPrice {
  instrumentSymbol: string;
  label: string | null;
  bestBid: string | null;
  bestAsk: string | null;
  lastTradePrice: string | null;
  observedAt: number | null;
}

export interface EventSummary {
  ticker: string;
  title: string;
  category: string | null;
  volume24h: string | null;
  expiryDate: string | null;
  lastSeenAt: number;
  contracts: ContractPrice[];
}

function units(price: string | null): bigint | null {
  if (price === null) return null;
  try {
    return toBaseUnits(price, PRICE_DECIMALS);
  } catch {
    return null;
  }
}

export function createMarketData(db: DB, now: () => number = Date.now) {
  const eventByTicker = db.prepare(
    "SELECT ticker, title, category, volume_24h, expiry_date, last_seen_at FROM gemini_events WHERE ticker = ?",
  );
  const contractsOf = db.prepare(
    "SELECT instrument_symbol, label FROM gemini_contracts WHERE event_ticker = ? ORDER BY instrument_symbol",
  );
  const latest = db.prepare(`
    SELECT best_bid, best_ask, last_trade_price, observed_at FROM odds_snapshots
    WHERE instrument_symbol = ? ORDER BY observed_at DESC LIMIT 1`);
  const series = db.prepare(`
    SELECT observed_at, best_bid, best_ask, last_trade_price FROM odds_snapshots
    WHERE instrument_symbol = ? AND observed_at >= ? ORDER BY observed_at`);
  const search = db.prepare(`
    SELECT ticker FROM gemini_events
    WHERE last_seen_at >= ? AND (title LIKE ? ESCAPE '\\' OR ticker LIKE ? ESCAPE '\\')
    ORDER BY CAST(volume_24h AS REAL) DESC LIMIT ?`);
  const sameCategory = db.prepare(`
    SELECT ticker FROM gemini_events
    WHERE last_seen_at >= ? AND category = ? AND ticker <> ?
    ORDER BY CAST(volume_24h AS REAL) DESC LIMIT ?`);
  const coverage = db.prepare("SELECT MIN(started_at) AS first, MAX(finished_at) AS last, COUNT(*) AS polls FROM recorder_polls WHERE error IS NULL");
  const pollTimes = db.prepare("SELECT started_at FROM recorder_polls WHERE error IS NULL AND started_at >= ? ORDER BY started_at");
  const failedPolls = db.prepare("SELECT COUNT(*) AS n FROM recorder_polls WHERE error IS NOT NULL AND started_at >= ?");

  function event(ticker: string): EventSummary | null {
    const e = eventByTicker.get(ticker) as
      | { ticker: string; title: string; category: string | null; volume_24h: string | null; expiry_date: string | null; last_seen_at: number }
      | undefined;
    if (!e) return null;
    const contracts = (contractsOf.all(ticker) as Array<{ instrument_symbol: string; label: string | null }>).map((c) => {
      const p = latest.get(c.instrument_symbol) as
        | { best_bid: string | null; best_ask: string | null; last_trade_price: string | null; observed_at: number }
        | undefined;
      return {
        instrumentSymbol: c.instrument_symbol, label: c.label,
        bestBid: p?.best_bid ?? null, bestAsk: p?.best_ask ?? null, lastTradePrice: p?.last_trade_price ?? null,
        observedAt: p?.observed_at ?? null,
      };
    });
    return {
      ticker: e.ticker, title: e.title, category: e.category, volume24h: e.volume_24h, expiryDate: e.expiry_date,
      lastSeenAt: e.last_seen_at, contracts,
    };
  }

  return {
    event,
    /** Successful-poll coverage since `sinceMs`, including the largest gap between consecutive successful polls. */
    recorderCoverage(sinceMs: number) {
      const times = (pollTimes.all(sinceMs) as Array<{ started_at: number }>).map((r) => r.started_at);
      let largestGapMs = 0;
      let largestGapStart: number | null = null;
      for (let i = 1; i < times.length; i++) {
        const gap = times[i] - times[i - 1];
        if (gap > largestGapMs) {
          largestGapMs = gap;
          largestGapStart = times[i - 1];
        }
      }
      return {
        successfulPolls: times.length,
        failedPolls: (failedPolls.get(sinceMs) as { n: number }).n,
        firstPollAt: times[0] ?? null,
        lastPollAt: times.at(-1) ?? null,
        largestGapMs,
        largestGapStart,
      };
    },
    search(query: string, limit = 8): EventSummary[] {
      const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      return (search.all(now() - ACTIVE_WINDOW_MS, like, like, limit) as Array<{ ticker: string }>)
        .map((r) => event(r.ticker))
        .filter((e): e is EventSummary => e !== null);
    },
    related(ticker: string, limit = 5): EventSummary[] {
      const e = event(ticker);
      if (!e?.category) return [];
      return (sameCategory.all(now() - ACTIVE_WINDOW_MS, e.category, ticker, limit) as Array<{ ticker: string }>)
        .map((r) => event(r.ticker))
        .filter((x): x is EventSummary => x !== null);
    },
    /** Recorded series per contract plus the change in best bid since the first recorded point. */
    history(ticker: string, sinceMs = 0) {
      const e = event(ticker);
      if (!e) return null;
      const contracts = e.contracts.map((c) => {
        const points = (series.all(c.instrumentSymbol, sinceMs) as Array<{
          observed_at: number; best_bid: string | null; best_ask: string | null; last_trade_price: string | null;
        }>).map((r) => ({ at: r.observed_at, bestBid: r.best_bid, bestAsk: r.best_ask, lastTradePrice: r.last_trade_price }));
        const first = units(points[0]?.bestBid ?? null);
        const last = units(points.at(-1)?.bestBid ?? null);
        const change = first !== null && last !== null ? last - first : null;
        return { label: c.label, instrumentSymbol: c.instrumentSymbol, points, bidChange: change };
      });
      const movers = contracts
        .filter((c) => c.bidChange !== null && c.bidChange !== 0n)
        .sort((a, b) => {
          const x = a.bidChange! < 0n ? -a.bidChange! : a.bidChange!;
          const y = b.bidChange! < 0n ? -b.bidChange! : b.bidChange!;
          return x === y ? 0 : x > y ? -1 : 1;
        })
        .slice(0, 5)
        .map((c) => ({ label: c.label, bidChange: formatBaseUnits(c.bidChange!, PRICE_DECIMALS) }));
      const cov = coverage.get() as { first: number | null; last: number | null; polls: number };
      return {
        ticker: e.ticker,
        title: e.title,
        recordedSince: cov.first,
        recordedUntil: cov.last,
        contracts: contracts.map((c) => ({
          ...c,
          bidChange: c.bidChange === null ? null : formatBaseUnits(c.bidChange, PRICE_DECIMALS),
        })),
        biggestMovers: movers,
      };
    },
  };
}

export type MarketData = ReturnType<typeof createMarketData>;
