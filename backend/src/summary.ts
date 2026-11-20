/**
 * One- or two-sentence summaries of paid results, for a voice agent to read out.
 * Gemini prices are USD per contract, which equal implied probabilities; percentages are
 * computed with integer math from bid/ask midpoints, each on its own (see percent.ts).
 */
import type { Purchase } from "./ledger.ts";
import { formatPercent } from "./percent.ts";
import { formatBaseUnits, toBaseUnits } from "./units.ts";

interface Contract { label?: string | null; instrumentSymbol?: string; bestBid?: string | null; bestAsk?: string | null }
interface EventLike { title?: string; category?: string | null; contracts?: Contract[] }
interface SnapshotResult { event?: EventLike | null }
interface HistoryResult {
  title?: string;
  recordedSince?: number | null;
  biggestMovers?: Array<{ label: string | null; bidChange: string }>;
  contracts?: Array<{ points?: Array<{ at: number }> }>;
}
interface BriefAnalysis {
  title: string;
  status: "ok" | "insufficient_history";
  leader: { label: string | null; impliedProbability: string } | null;
  biggestMove: { label: string | null; changePoints: string; since: number } | null;
  contracts: Array<{ history: { status: string; firstObservedAt: number | null } }>;
}
interface BriefResult {
  mock?: boolean;
  event?: EventLike | null;
  relatedMarkets?: EventLike[];
  analysis?: BriefAnalysis | null;
  relatedAnalysis?: Array<{ title: string; leader: { label: string | null; impliedProbability: string } | null }>;
}

/** Same thresholds as brief.ts: movement is only described with 2+ observations over 15+ minutes. */
const MIN_OBSERVATIONS = 2;
const MIN_HISTORY_MS = 15 * 60_000;
const hasMovementHistory = (points: Array<{ at: number }> = []) =>
  points.length >= MIN_OBSERVATIONS && points[points.length - 1].at - points[0].at >= MIN_HISTORY_MS;

/** "+3.5" -> "up 3.5 points", "-2" -> "down 2 points". */
const describePoints = (p: string) => `${p.startsWith("-") ? "down" : "up"} ${p.replace(/^[+-]/, "")} points`;

const MAX_SPOKEN_CONTRACTS = 6;

function micro(price: string | null | undefined): bigint | null {
  if (typeof price !== "string") return null;
  try {
    return toBaseUnits(price, 6);
  } catch {
    return null;
  }
}

/** Midpoint of bid/ask as a percentage with at most one decimal, e.g. "0.51"/"0.52" -> "51.5%". */
export function impliedPercent(bid?: string | null, ask?: string | null): string | null {
  const b = micro(bid);
  const a = micro(ask);
  const mid = b !== null && a !== null ? (b + a) / 2n : b ?? a;
  if (mid === null || mid < 0n) return null;
  return formatPercent(mid, 6);
}

/** "0.03" -> "3", "-0.025" -> "2.5" (probability points, sign dropped). */
function points(change: string): string {
  const v = micro(change.replace(/^-/, ""));
  return v === null ? change : formatBaseUnits(v, 4);
}

const clock = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(ms);

export function spokenSummary(p: Purchase, timeZone = "America/Chicago"): string | null {
  if (p.state !== "accepted" && p.state !== "settled") return null;
  switch (p.itemId) {
    case "odds_snapshot": {
      const e = (p.result as SnapshotResult | null)?.event;
      if (!e?.contracts?.length) return null;
      const parts = e.contracts
        .map((c) => ({ label: c.label ?? c.instrumentSymbol ?? "?", pct: impliedPercent(c.bestBid, c.bestAsk) }))
        .filter((x) => x.pct !== null)
        .slice(0, MAX_SPOKEN_CONTRACTS)
        .map((x) => `${x.label} about ${x.pct}`);
      const more = e.contracts.length > MAX_SPOKEN_CONTRACTS ? ` (and ${e.contracts.length - MAX_SPOKEN_CONTRACTS} more)` : "";
      return `${e.title}: ${parts.join(", ")}${more}. These are implied probabilities from the bid/ask midpoint.`;
    }
    case "odds_history": {
      const h = p.result as HistoryResult | null;
      if (!h) return null;
      const since = h.recordedSince ? ` since ${clock(h.recordedSince, timeZone)}` : "";
      if (!h.biggestMovers?.length) {
        const enough = (h.contracts ?? []).some((c) => hasMovementHistory(c.points));
        return enough
          ? `${h.title}: no price changes recorded${since}.`
          : `${h.title}: not enough recorded history yet to describe movement${since}.`;
      }
      const moves = h.biggestMovers.map((m) => `${m.label ?? "?"} ${m.bidChange.startsWith("-") ? "down" : "up"} ${points(m.bidChange)} points`);
      return `${h.title}${since}: ${moves.join(", ")}.`;
    }
    case "deep_brief": {
      const b = p.result as BriefResult | null;
      const a = b?.analysis;
      if (a) {
        const parts: string[] = [
          a.leader ? `${a.title}: ${a.leader.label ?? "?"} leads at about ${a.leader.impliedProbability}` : `${a.title}: no current prices recorded`,
        ];
        if (a.status === "ok") {
          const starts = a.contracts.filter((c) => c.history.status === "ok" && c.history.firstObservedAt !== null).map((c) => c.history.firstObservedAt!);
          const since = starts.length ? ` since ${clock(Math.min(...starts), timeZone)}` : "";
          parts.push(a.biggestMove ? `biggest move${since}: ${a.biggestMove.label ?? "?"} ${describePoints(a.biggestMove.changePoints)}` : `no change${since}`);
        } else {
          parts.push("not enough recorded history yet to describe movement");
        }
        const related = (b?.relatedAnalysis ?? []).filter((r) => r.leader).slice(0, 2)
          .map((r) => `${r.title}, ${r.leader!.label ?? "?"} about ${r.leader!.impliedProbability}`);
        return `${parts.join("; ")}.${related.length ? ` Related: ${related.join("; ")}.` : ""}`;
      }
      // Purchases made before the real brief existed carry the old placeholder result.
      const related = b?.relatedMarkets ?? [];
      const names = related.slice(0, 3).map((r) => r.title).filter(Boolean).join("; ");
      const head = related.length ? `${related.length} related ${b?.event?.category ?? ""} markets: ${names}.`.replace("  ", " ") : "No related markets found.";
      return `${head}${b?.mock ? " The written analysis is still a placeholder." : ""}`;
    }
    default:
      return "Placeholder report.";
  }
}
