/**
 * Deep brief, computed only from prices the recorder actually observed.
 *
 * - Current state (implied probability = bid/ask midpoint, spread, leader) comes from the latest
 *   recorded snapshot of each contract.
 * - Movement (change, high, low, biggest move) is reported only when a contract has at least
 *   MIN_OBSERVATIONS rows spanning at least MIN_HISTORY_MINUTES. Otherwise the brief says
 *   "insufficient_history", gives the reason, and leaves every movement field null. It never
 *   interpolates or guesses.
 * - The recorder writes a row when a price changes plus a heartbeat every 15 minutes, so a steady
 *   price over 15+ minutes is a real "no change", not missing data. Gaps between successful recorder
 *   polls longer than MAX_POLL_GAP_MINUTES are called out, since moves inside a gap were not observed.
 * All arithmetic is on integers (prices scaled to 6 decimals); outputs are decimal strings.
 * Percentages (formatPercent) show at most one decimal and are never normalized to add up to 100%;
 * `probabilitiesSum` is the exact sum of the midpoints, formatted once.
 */
import type { MarketData } from "./market-data.ts";
import { formatPercent } from "./percent.ts";
import { formatBaseUnits, toBaseUnits } from "./units.ts";

export const MIN_OBSERVATIONS = 2;
export const MIN_HISTORY_MINUTES = 15;
export const MAX_POLL_GAP_MINUTES = 10;
const DECIMALS = 6;
const MINUTE = 60_000;

type Status = "ok" | "insufficient_history";

export interface ContractAnalysis {
  label: string | null;
  instrumentSymbol: string;
  current: {
    bestBid: string | null;
    bestAsk: string | null;
    lastTradePrice: string | null;
    mid: string | null;
    impliedProbability: string | null;
    spread: string | null;
    observedAt: number | null;
  };
  history: {
    status: Status;
    observations: number;
    firstObservedAt: number | null;
    lastObservedAt: number | null;
    windowMinutes: number | null;
    reason: string | null;
    firstMid: string | null;
    change: string | null;
    changePoints: string | null;
    high: string | null;
    low: string | null;
  };
}

export interface EventAnalysis {
  ticker: string;
  title: string;
  category: string | null;
  status: Status;
  leader: { label: string | null; impliedProbability: string } | null;
  probabilitiesSum: string | null;
  widestSpread: { label: string | null; spread: string } | null;
  biggestMove: { label: string | null; changePoints: string; since: number } | null;
  contracts: ContractAnalysis[];
  notes: string[];
}

function micro(price: string | null | undefined): bigint | null {
  if (typeof price !== "string") return null;
  try {
    return toBaseUnits(price, DECIMALS);
  } catch {
    return null;
  }
}

function midOf(bid: string | null, ask: string | null, last: string | null): bigint | null {
  const b = micro(bid);
  const a = micro(ask);
  if (b !== null && a !== null) return (b + a) / 2n;
  return b ?? a ?? micro(last);
}

const price = (v: bigint | null) => (v === null ? null : formatBaseUnits(v, DECIMALS));
const percent = (v: bigint) => formatPercent(v, DECIMALS);
/** Price difference -> signed probability points, e.g. 0.035 -> "+3.5", -0.02 -> "-2". */
function signedPoints(diff: bigint): string {
  const abs = diff < 0n ? -diff : diff;
  const text = formatBaseUnits(abs * 100n, DECIMALS);
  return diff > 0n ? `+${text}` : diff < 0n ? `-${text}` : "0";
}
const abs = (v: bigint) => (v < 0n ? -v : v);

export function analyzeEvent(market: MarketData, ticker: string): EventAnalysis | null {
  const event = market.event(ticker);
  const history = market.history(ticker);
  if (!event || !history) return null;
  const pointsBySymbol = new Map(history.contracts.map((c) => [c.instrumentSymbol, c.points]));
  const notes: string[] = [];
  const changes: Array<bigint | null> = [];

  const contracts: ContractAnalysis[] = event.contracts.map((c) => {
    const currentMid = midOf(c.bestBid, c.bestAsk, c.lastTradePrice);
    const bid = micro(c.bestBid);
    const ask = micro(c.bestAsk);
    const points = (pointsBySymbol.get(c.instrumentSymbol) ?? []).map((p) => ({ at: p.at, mid: midOf(p.bestBid, p.bestAsk, p.lastTradePrice) }));
    const priced = points.filter((p): p is { at: number; mid: bigint } => p.mid !== null);
    const first = priced[0];
    const last = priced.at(-1);
    const windowMinutes = first && last ? Math.floor((last.at - first.at) / MINUTE) : null;

    let reason: string | null = null;
    if (priced.length === 0) reason = "No priced observations recorded for this contract";
    else if (priced.length < MIN_OBSERVATIONS) reason = `Only ${priced.length} observation recorded; movement needs at least ${MIN_OBSERVATIONS}`;
    else if ((windowMinutes ?? 0) < MIN_HISTORY_MINUTES) reason = `Observations span ${windowMinutes} min; movement needs at least ${MIN_HISTORY_MINUTES} min`;
    const ok = reason === null;

    let high: bigint | null = null;
    let low: bigint | null = null;
    if (ok) {
      for (const p of priced) {
        if (high === null || p.mid > high) high = p.mid;
        if (low === null || p.mid < low) low = p.mid;
      }
    }
    const change = ok ? last!.mid - first!.mid : null;
    changes.push(change);

    return {
      label: c.label,
      instrumentSymbol: c.instrumentSymbol,
      current: {
        bestBid: c.bestBid,
        bestAsk: c.bestAsk,
        lastTradePrice: c.lastTradePrice,
        mid: price(currentMid),
        impliedProbability: currentMid === null ? null : percent(currentMid),
        spread: bid !== null && ask !== null && ask >= bid ? price(ask - bid) : null,
        observedAt: c.observedAt,
      },
      history: {
        status: ok ? "ok" : "insufficient_history",
        observations: priced.length,
        firstObservedAt: first?.at ?? null,
        lastObservedAt: last?.at ?? null,
        windowMinutes,
        reason,
        firstMid: ok ? price(first!.mid) : null,
        change: change === null ? null : (change > 0n ? "+" : "") + formatBaseUnits(change, DECIMALS),
        changePoints: change === null ? null : signedPoints(change),
        high: ok ? price(high) : null,
        low: ok ? price(low) : null,
      },
    };
  });

  const mids = event.contracts.map((c) => midOf(c.bestBid, c.bestAsk, c.lastTradePrice));
  let leaderIndex = -1;
  mids.forEach((m, i) => {
    if (m !== null && (leaderIndex < 0 || m > mids[leaderIndex]!)) leaderIndex = i;
  });
  const priced = mids.filter((m): m is bigint => m !== null);
  const sum = priced.length === mids.length && priced.length > 0 ? priced.reduce((a, b) => a + b, 0n) : null;

  let widest: ContractAnalysis | null = null;
  for (const c of contracts) {
    if (c.current.spread !== null && (widest === null || micro(c.current.spread)! > micro(widest.current.spread)!)) widest = c;
  }

  let moverIndex = -1;
  changes.forEach((d, i) => {
    if (d !== null && d !== 0n && (moverIndex < 0 || abs(d) > abs(changes[moverIndex]!))) moverIndex = i;
  });
  const mover = moverIndex < 0 ? null : contracts[moverIndex];

  const status: Status = contracts.some((c) => c.history.status === "ok") ? "ok" : "insufficient_history";
  if (status === "insufficient_history") {
    notes.push(`Not enough recorded history to describe movement for any contract (needs ${MIN_OBSERVATIONS}+ observations over ${MIN_HISTORY_MINUTES}+ min).`);
  }
  const since = contracts.map((c) => c.history.firstObservedAt).filter((t): t is number => t !== null);
  if (since.length) {
    const cov = market.recorderCoverage(Math.min(...since));
    if (cov.largestGapMs > MAX_POLL_GAP_MINUTES * MINUTE && cov.largestGapStart !== null) {
      notes.push(`Recorder gap of ${Math.round(cov.largestGapMs / MINUTE)} min starting ${new Date(cov.largestGapStart).toISOString()}; moves inside it were not observed.`);
    }
    if (cov.failedPolls > 0) notes.push(`${cov.failedPolls} recorder poll(s) failed in this window.`);
  }
  if (sum !== null && contracts.length > 2) {
    notes.push("This event has more than two outcomes; the probabilities sum is a market-wide check, not a forecast.");
  }

  return {
    ticker: event.ticker,
    title: event.title,
    category: event.category,
    status,
    leader: leaderIndex < 0 ? null : { label: event.contracts[leaderIndex].label, impliedProbability: percent(mids[leaderIndex]!) },
    probabilitiesSum: sum === null ? null : percent(sum),
    widestSpread: widest ? { label: widest.label, spread: widest.current.spread! } : null,
    biggestMove: mover ? { label: mover.label, changePoints: mover.history.changePoints!, since: mover.history.firstObservedAt! } : null,
    contracts,
    notes,
  };
}

/** The `result` of a paid deep_brief. Keeps the documented fields (mock, note, event, relatedMarkets). */
export function buildDeepBrief(market: MarketData, ticker: string, now: number = Date.now()) {
  const analysis = analyzeEvent(market, ticker);
  const related = market.related(ticker, 5);
  const relatedAnalysis = related
    .map((r) => analyzeEvent(market, r.ticker))
    .filter((a): a is EventAnalysis => a !== null)
    .map((a) => ({ ticker: a.ticker, title: a.title, status: a.status, leader: a.leader, biggestMove: a.biggestMove }));
  const history = market.history(ticker);
  return {
    mock: false,
    note: "Computed only from recorded Gemini prices. Movement is reported only where analysis.status / contracts[].history.status is \"ok\"; otherwise the reason is given and movement fields are null.",
    generatedAt: now,
    method: {
      impliedProbability: "midpoint of best bid and best ask (USD per contract)",
      minObservations: MIN_OBSERVATIONS,
      minHistoryMinutes: MIN_HISTORY_MINUTES,
      maxPollGapMinutes: MAX_POLL_GAP_MINUTES,
    },
    coverage: { recordedSince: history?.recordedSince ?? null, recordedUntil: history?.recordedUntil ?? null },
    event: market.event(ticker),
    analysis,
    relatedMarkets: related,
    relatedAnalysis,
  };
}

export type DeepBrief = ReturnType<typeof buildDeepBrief>;
