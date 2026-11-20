/**
 * Odds recorder. Gemini publishes no historical odds endpoint, so price history exists only
 * from the moment this starts. Each poll pages through all active events, upserts event and
 * contract metadata, and writes an odds_snapshots row for a contract only when its prices
 * changed or its last row is older than the heartbeat interval.
 */
import type { DB } from "./db.ts";
import { cleanPrice, fetchActiveEventsPage, GeminiHttpError, type FetchEventsPage, type GeminiEvent } from "./gemini.ts";

export interface RecorderOptions {
  intervalMs: number;
  pageSize: number;
  pageDelayMs: number;
  heartbeatMs: number;
  maxPages: number;
  maxBackoffMs: number;
  fetchPage: FetchEventsPage;
  log: (line: string) => void;
  now: () => number;
}

export const DEFAULT_RECORDER_OPTIONS: RecorderOptions = {
  intervalMs: 60_000,
  pageSize: 250,
  pageDelayMs: 400,
  heartbeatMs: 15 * 60_000,
  maxPages: 20,
  maxBackoffMs: 10 * 60_000,
  fetchPage: fetchActiveEventsPage,
  log: (line) => console.log(line),
  now: () => Date.now(),
};

export interface PollResult {
  pollId: number;
  pages: number;
  events: number;
  contracts: number;
  snapshots: number;
  ms: number;
}

interface LastPrices {
  bid: string | null;
  ask: string | null;
  last: string | null;
  at: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createRecorder(db: DB, overrides: Partial<RecorderOptions> = {}) {
  const opts: RecorderOptions = { ...DEFAULT_RECORDER_OPTIONS, ...overrides };
  const lastByInstrument = new Map<string, LastPrices>();
  for (const row of db
    .prepare(
      `SELECT instrument_symbol AS s, best_bid AS bid, best_ask AS ask, last_trade_price AS last, MAX(observed_at) AS at
       FROM odds_snapshots GROUP BY instrument_symbol`,
    )
    .all() as Array<{ s: string } & LastPrices>) {
    lastByInstrument.set(row.s, { bid: row.bid, ask: row.ask, last: row.last, at: row.at });
  }

  const insertPoll = db.prepare("INSERT INTO recorder_polls (started_at) VALUES (?)");
  const finishPoll = db.prepare(
    "UPDATE recorder_polls SET finished_at = ?, pages = ?, events = ?, contracts = ?, snapshots = ?, error = ? WHERE id = ?",
  );
  const upsertEvent = db.prepare(`
    INSERT INTO gemini_events (ticker, event_id, title, category, status, volume, volume_24h, start_time, expiry_date, first_seen_at, last_seen_at)
    VALUES (@ticker, @eventId, @title, @category, @status, @volume, @volume24h, @startTime, @expiryDate, @now, @now)
    ON CONFLICT(ticker) DO UPDATE SET title = excluded.title, category = excluded.category, status = excluded.status,
      volume = excluded.volume, volume_24h = excluded.volume_24h, start_time = excluded.start_time,
      expiry_date = excluded.expiry_date, last_seen_at = excluded.last_seen_at`);
  const upsertContract = db.prepare(`
    INSERT INTO gemini_contracts (instrument_symbol, event_ticker, contract_id, label, ticker, status, market_state, last_seen_at)
    VALUES (@symbol, @eventTicker, @contractId, @label, @ticker, @status, @marketState, @now)
    ON CONFLICT(instrument_symbol) DO UPDATE SET label = excluded.label, status = excluded.status,
      market_state = excluded.market_state, last_seen_at = excluded.last_seen_at`);
  const insertSnapshot = db.prepare(`
    INSERT OR IGNORE INTO odds_snapshots (instrument_symbol, observed_at, best_bid, best_ask, last_trade_price, poll_id)
    VALUES (?, ?, ?, ?, ?, ?)`);

  const store = db.transaction((events: GeminiEvent[], pollId: number, now: number) => {
    let contracts = 0;
    let snapshots = 0;
    for (const e of events) {
      if (!e.ticker || !e.id || !e.title) continue;
      upsertEvent.run({
        ticker: e.ticker, eventId: e.id, title: e.title, category: e.category ?? null, status: e.status ?? null,
        volume: e.volume ?? null, volume24h: e.volume24h ?? null, startTime: e.startTime ?? null,
        expiryDate: e.expiryDate ?? null, now,
      });
      for (const c of e.contracts ?? []) {
        const symbol = c.instrumentSymbol ?? `${e.ticker}:${c.id}`;
        upsertContract.run({
          symbol, eventTicker: e.ticker, contractId: c.id, label: c.label ?? null, ticker: c.ticker ?? null,
          status: c.status ?? null, marketState: c.marketState ?? null, now,
        });
        contracts++;
        const next = {
          bid: cleanPrice(c.prices?.bestBid),
          ask: cleanPrice(c.prices?.bestAsk),
          last: cleanPrice(c.prices?.lastTradePrice),
        };
        const prev = lastByInstrument.get(symbol);
        const due =
          !prev ||
          prev.bid !== next.bid ||
          prev.ask !== next.ask ||
          prev.last !== next.last ||
          now - prev.at >= opts.heartbeatMs;
        if (due) {
          insertSnapshot.run(symbol, now, next.bid, next.ask, next.last, pollId);
          lastByInstrument.set(symbol, { ...next, at: now });
          snapshots++;
        }
      }
    }
    return { contracts, snapshots };
  });

  async function pollOnce(): Promise<PollResult> {
    const started = opts.now();
    const pollId = Number(insertPoll.run(started).lastInsertRowid);
    const events: GeminiEvent[] = [];
    let pages = 0;
    try {
      let offset = 0;
      let total = Infinity;
      while (offset < total && pages < opts.maxPages) {
        if (pages > 0) await sleep(opts.pageDelayMs);
        const page = await opts.fetchPage(offset, opts.pageSize);
        pages++;
        total = page.pagination.total;
        events.push(...page.data);
        if (page.data.length === 0) break;
        offset += page.data.length;
      }
      const { contracts, snapshots } = store.immediate(events, pollId, started);
      const finished = opts.now();
      finishPoll.run(finished, pages, events.length, contracts, snapshots, null, pollId);
      return { pollId, pages, events: events.length, contracts, snapshots, ms: finished - started };
    } catch (err) {
      finishPoll.run(opts.now(), pages, events.length, null, null, String((err as Error).message).slice(0, 500), pollId);
      throw err;
    }
  }

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let failures = 0;

  async function loop(): Promise<void> {
    if (stopped) return;
    let delay = opts.intervalMs;
    try {
      const r = await pollOnce();
      failures = 0;
      opts.log(`[recorder] poll ${r.pollId}: ${r.events} events, ${r.contracts} contracts, ${r.snapshots} snapshot rows, ${r.pages} pages, ${r.ms} ms`);
    } catch (err) {
      failures++;
      const retryAfterMs = err instanceof GeminiHttpError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : 0;
      delay = Math.min(opts.maxBackoffMs, Math.max(retryAfterMs, opts.intervalMs * 2 ** Math.min(failures, 4)));
      opts.log(`[recorder] poll failed (${(err as Error).message}); retrying in ${Math.round(delay / 1000)} s`);
    }
    if (!stopped) timer = setTimeout(loop, delay);
  }

  return {
    pollOnce,
    start(): void {
      stopped = false;
      void loop();
    },
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
