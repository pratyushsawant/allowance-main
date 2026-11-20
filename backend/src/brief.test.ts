/**
 * Deep brief built from recorder data. Polls are driven with a controlled clock so every number is
 * known in advance; the brief must report insufficient history rather than invent movement.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEvent, buildDeepBrief } from "./brief.ts";
import { getItem } from "./catalog.ts";
import { openDatabase } from "./db.ts";
import type { GeminiEvent } from "./gemini.ts";
import type { Purchase } from "./ledger.ts";
import { createMarketData } from "./market-data.ts";
import { createRecorder } from "./recorder.ts";
import { spokenSummary } from "./summary.ts";

const T0 = Date.UTC(2026, 10, 20, 12, 0); // 6:00 AM America/Chicago
const MIN = 60_000;

function setup() {
  const db = openDatabase(":memory:");
  let clock = T0;
  let events: GeminiEvent[] = [];
  const recorder = createRecorder(db, {
    now: () => clock, pageDelayMs: 0, log: () => {},
    fetchPage: async (offset, limit) => ({ data: offset ? [] : events, pagination: { limit, offset, total: events.length } }),
  });
  const market = createMarketData(db, () => clock);
  return {
    market,
    poll: async (at: number, e: GeminiEvent[]) => {
      clock = at;
      events = e;
      await recorder.pollOnce();
    },
  };
}

const event = (ticker: string, title: string, prices: Array<[string, string | undefined, string | undefined]>, category = "Sports"): GeminiEvent => ({
  id: ticker, ticker, title, category,
  contracts: prices.map(([label, bestBid, bestAsk], i) => ({ id: `${ticker}-${i}`, label, instrumentSymbol: `GEMI-${ticker}-${i}`, prices: { bestBid, bestAsk } })),
});
const brief = (market: ReturnType<typeof createMarketData>, ticker = "EVT") =>
  spokenSummary({ state: "accepted", itemId: "deep_brief", result: buildDeepBrief(market, ticker, T0) } as Purchase);

test("one observation: current state only, no movement invented", async () => {
  const s = setup();
  await s.poll(T0, [event("EVT", "A vs B", [["A", "0.51", "0.52"], ["B", "0.48", "0.49"]])]);
  const a = analyzeEvent(s.market, "EVT")!;
  assert.equal(a.status, "insufficient_history");
  assert.deepEqual(a.leader, { label: "A", impliedProbability: "51.5%" });
  assert.deepEqual(a.contracts.map((c) => [c.current.mid, c.current.impliedProbability]), [["0.515", "51.5%"], ["0.485", "48.5%"]]);
  assert.equal(a.probabilitiesSum, "100%");
  assert.deepEqual(a.widestSpread, { label: "A", spread: "0.01" });
  assert.equal(a.biggestMove, null);
  for (const c of a.contracts) {
    assert.equal(c.history.observations, 1);
    assert.match(c.history.reason!, /Only 1 observation recorded/);
    assert.deepEqual([c.history.change, c.history.changePoints, c.history.high, c.history.low, c.history.firstMid], [null, null, null, null, null]);
  }
  assert.equal(brief(s.market), "A vs B: A leads at about 51.5%; not enough recorded history yet to describe movement.");
});

test("percentages keep the market's own total: never normalized to 100%", async () => {
  const s = setup();
  // Midpoints 0.525 + 0.495 = 1.02: a 2-point overround that must stay visible.
  await s.poll(T0, [event("EVT", "A vs B", [["A", "0.52", "0.53"], ["B", "0.49", "0.50"]])]);
  const a = analyzeEvent(s.market, "EVT")!;
  assert.deepEqual(a.contracts.map((c) => c.current.impliedProbability), ["52.5%", "49.5%"]);
  assert.equal(a.probabilitiesSum, "102%", "the exact sum of the midpoints, not the sum of rounded values");
  // An underround book stays under 100% too.
  await s.poll(T0 + MIN, [event("EVT", "A vs B", [["A", "0.50", "0.51"], ["B", "0.47", "0.48"]])]);
  assert.equal(analyzeEvent(s.market, "EVT")!.probabilitiesSum, "98%");
});

test("the catalog describes what the brief actually computes", () => {
  const item = getItem("deep_brief")!;
  assert.match(item.description, /recorded prices/);
  assert.match(item.description, /movement where enough history has been recorded/);
  assert.equal(item.priceUsdc, "0.75", "price unchanged");
});

test("observations too close together are not treated as history", async () => {
  const s = setup();
  await s.poll(T0, [event("EVT", "A vs B", [["A", "0.40", "0.42"], ["B", "0.58", "0.60"]])]);
  await s.poll(T0 + 5 * MIN, [event("EVT", "A vs B", [["A", "0.45", "0.47"], ["B", "0.53", "0.55"]])]);
  const a = analyzeEvent(s.market, "EVT")!;
  assert.equal(a.status, "insufficient_history");
  assert.match(a.contracts[0].history.reason!, /span 5 min; movement needs at least 15 min/);
  assert.equal(a.contracts[0].history.change, null);
});

test("real movement over 20 minutes: exact change, high, low and biggest move", async () => {
  const s = setup();
  await s.poll(T0, [event("EVT", "A vs B", [["A", "0.40", "0.42"], ["B", "0.58", "0.60"]])]);
  await s.poll(T0 + 20 * MIN, [event("EVT", "A vs B", [["A", "0.45", "0.47"], ["B", "0.51", "0.53"]])]);
  const a = analyzeEvent(s.market, "EVT")!;
  assert.equal(a.status, "ok");
  const [A, B] = a.contracts;
  assert.deepEqual([A.history.firstMid, A.current.mid, A.history.change, A.history.changePoints, A.history.high, A.history.low], ["0.41", "0.46", "+0.05", "+5", "0.46", "0.41"]);
  assert.deepEqual([B.history.change, B.history.changePoints, B.history.windowMinutes], ["-0.07", "-7", 20]);
  assert.deepEqual(a.biggestMove, { label: "B", changePoints: "-7", since: T0 });
  assert.deepEqual(a.leader, { label: "B", impliedProbability: "52%" });
  assert.equal(brief(s.market), "A vs B: B leads at about 52%; biggest move since 6:00 AM: B down 7 points.");
});

test("steady price over 30+ minutes (heartbeat rows) is a real 'no change'", async () => {
  const s = setup();
  const e = [event("EVT", "A vs B", [["A", "0.51", "0.52"], ["B", "0.48", "0.49"]])];
  await s.poll(T0, e);
  await s.poll(T0 + 16 * MIN, e); // heartbeat row
  await s.poll(T0 + 32 * MIN, e); // heartbeat row
  const a = analyzeEvent(s.market, "EVT")!;
  assert.equal(a.status, "ok");
  assert.deepEqual([a.contracts[0].history.observations, a.contracts[0].history.change, a.contracts[0].history.changePoints], [3, "0", "0"]);
  assert.equal(a.biggestMove, null);
  assert.equal(brief(s.market), "A vs B: A leads at about 51.5%; no change since 6:00 AM.");
});

test("a long gap between recorder polls is called out", async () => {
  const s = setup();
  await s.poll(T0, [event("EVT", "A vs B", [["A", "0.40", "0.42"], ["B", "0.58", "0.60"]])]);
  await s.poll(T0 + 40 * MIN, [event("EVT", "A vs B", [["A", "0.45", "0.47"], ["B", "0.53", "0.55"]])]);
  const a = analyzeEvent(s.market, "EVT")!;
  assert.equal(a.status, "ok");
  assert.ok(a.notes.some((n) => /Recorder gap of 40 min/.test(n)), a.notes.join(" | "));
});

test("missing prices stay missing", async () => {
  const s = setup();
  await s.poll(T0, [event("EVT", "A vs B", [["A", "0.51", "0.52"], ["B", undefined, undefined]])]);
  const a = analyzeEvent(s.market, "EVT")!;
  assert.deepEqual([a.contracts[1].current.mid, a.contracts[1].current.impliedProbability, a.contracts[1].current.spread], [null, null, null]);
  assert.equal(a.probabilitiesSum, null, "no sum when an outcome has no price");
  assert.deepEqual(a.leader, { label: "A", impliedProbability: "51.5%" });
});

test("result keeps the documented fields and adds analysis for related markets", async () => {
  const s = setup();
  const both = [
    event("EVT", "A vs B", [["A", "0.51", "0.52"], ["B", "0.48", "0.49"]]),
    event("REL", "C vs D", [["C", "0.70", "0.72"], ["D", "0.28", "0.30"]]),
  ];
  await s.poll(T0, both);
  const r = buildDeepBrief(s.market, "EVT", T0);
  assert.equal(r.mock, false);
  assert.equal(typeof r.note, "string");
  assert.equal(r.event?.ticker, "EVT");
  assert.deepEqual(r.relatedMarkets.map((m) => m.ticker), ["REL"], "relatedMarkets keeps its EventSummary shape");
  assert.deepEqual(r.relatedAnalysis, [{ ticker: "REL", title: "C vs D", status: "insufficient_history", leader: { label: "C", impliedProbability: "71%" }, biggestMove: null }]);
  assert.deepEqual(r.method, { impliedProbability: "midpoint of best bid and best ask (USD per contract)", minObservations: 2, minHistoryMinutes: 15, maxPollGapMinutes: 10 });
  assert.equal(brief(s.market), "A vs B: A leads at about 51.5%; not enough recorded history yet to describe movement. Related: C vs D, C about 71%.");
});

test("purchases made before the real brief keep their old summary", () => {
  const legacy = spokenSummary({ state: "settled", itemId: "deep_brief", result: { mock: true, relatedMarkets: [] } } as unknown as Purchase);
  assert.match(legacy!, /placeholder/);
});
