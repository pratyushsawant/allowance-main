import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "./db.ts";
import { GeminiHttpError, type EventsPage, type GeminiEvent } from "./gemini.ts";
import { createRecorder } from "./recorder.ts";

const event = (bid: string, ask: string, extra: Partial<GeminiEvent> = {}): GeminiEvent => ({
  id: "1", ticker: "EVT", title: "Test event", category: "Test",
  contracts: [{ id: "1-1", label: "Yes", instrumentSymbol: "GEMI-EVT-YES", prices: { bestBid: bid, bestAsk: ask } }],
  ...extra,
});

function fakePages(pages: GeminiEvent[][]) {
  const calls: Array<[number, number]> = [];
  const all = pages.flat();
  return {
    calls,
    fetchPage: async (offset: number, limit: number): Promise<EventsPage> => {
      calls.push([offset, limit]);
      return { data: all.slice(offset, offset + limit), pagination: { limit, offset, total: all.length } };
    },
  };
}

test("recorder pages through all events and stores one row per contract on first poll", async () => {
  const db = openDatabase(":memory:");
  const events = Array.from({ length: 5 }, (_, i) => ({
    ...event("0.40", "0.42"), id: String(i), ticker: `EVT${i}`,
    contracts: [{ id: `${i}-1`, instrumentSymbol: `GEMI-EVT${i}-YES`, prices: { bestBid: "0.40", bestAsk: "0.42" } }],
  }));
  const { calls, fetchPage } = fakePages([events]);
  const rec = createRecorder(db, { fetchPage, pageSize: 2, pageDelayMs: 0, log: () => {} });
  const r = await rec.pollOnce();
  assert.deepEqual(calls, [[0, 2], [2, 2], [4, 2]]);
  assert.equal(r.events, 5);
  assert.equal(r.snapshots, 5);
});

test("recorder writes a snapshot only on change or heartbeat", async () => {
  const db = openDatabase(":memory:");
  let clock = 1_000_000;
  let current = [event("0.40", "0.42")];
  const rec = createRecorder(db, {
    fetchPage: async (offset, limit) => ({ data: offset ? [] : current, pagination: { limit, offset, total: current.length } }),
    pageDelayMs: 0, heartbeatMs: 15 * 60_000, now: () => clock, log: () => {},
  });
  assert.equal((await rec.pollOnce()).snapshots, 1); // first sight
  clock += 60_000;
  assert.equal((await rec.pollOnce()).snapshots, 0); // unchanged
  current = [event("0.45", "0.47")];
  clock += 60_000;
  assert.equal((await rec.pollOnce()).snapshots, 1); // changed
  clock += 15 * 60_000;
  assert.equal((await rec.pollOnce()).snapshots, 1); // heartbeat
  const rows = db.prepare("SELECT best_bid, best_ask FROM odds_snapshots ORDER BY observed_at").all();
  assert.deepEqual(rows, [
    { best_bid: "0.40", best_ask: "0.42" },
    { best_bid: "0.45", best_ask: "0.47" },
    { best_bid: "0.45", best_ask: "0.47" },
  ]);
});

test("recorder keeps prices exact and drops malformed ones", async () => {
  const db = openDatabase(":memory:");
  const bad = event("0.123456789", "abc");
  const rec = createRecorder(db, {
    fetchPage: async (offset, limit) => ({ data: offset ? [] : [bad], pagination: { limit, offset, total: 1 } }),
    pageDelayMs: 0, log: () => {},
  });
  await rec.pollOnce();
  assert.deepEqual(db.prepare("SELECT best_bid, best_ask FROM odds_snapshots").get(), { best_bid: "0.123456789", best_ask: null });
});

test("a failed poll is recorded with its error and rethrown", async () => {
  const db = openDatabase(":memory:");
  const rec = createRecorder(db, {
    fetchPage: async () => { throw new GeminiHttpError(429, 30); },
    log: () => {},
  });
  await assert.rejects(rec.pollOnce(), GeminiHttpError);
  const poll = db.prepare("SELECT error, finished_at IS NOT NULL AS done FROM recorder_polls").get() as { error: string; done: number };
  assert.match(poll.error, /429/);
  assert.equal(poll.done, 1);
});
