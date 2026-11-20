// RulesFlow: a purchase travels through the four spending rules, one gate at a time.
// First a small purchase passes all four; then a bigger one passes three and stops at
// "Your OK". Every check uses the real rules passed in, so editing them changes the result.
// Colors come from the theme tokens in src/index.css: pine = brand blue, hold = amber.
import { useEffect, useState } from "react";
import { Check, Coins, Hand, X, type LucideIcon } from "lucide-react";
import { RULES, ruleValues } from "./rules";
import { usd } from "../format";

type Props = {
  sellers: string[];
  perRequestCap: number;
  dailyBudget: number;
  approvalThreshold: number;
  spentToday: number;
};

// Real catalog items (backend/src/catalog.ts), checked against the live rules passed in.
type Purchase = { amount: number; seller: string; what: string };
const PURCHASES: Purchase[] = [
  { amount: 0.005, seller: "Odds Desk", what: "Odds snapshot: latest prices for one market" },
  { amount: 0.75, seller: "Odds Desk", what: "Deep brief: computed from recorded prices" },
];

// Timeline (ms) for one purchase, and when the second one starts.
const GATE_START = 600;
const GATE_STEP = 900;
const SECOND_AT = 7000;
const LOOP_MS = 14500;

type GateState = "idle" | "checking" | "pass" | "stop" | "block";
type Gate = { icon: LucideIcon; title: string; value: string; ok: boolean; soft?: boolean; why: string };

const usdc = (n: number) => `${usd(n)} USDC`;

export function RulesFlow({ sellers, perRequestCap, dailyBudget, approvalThreshold, spentToday }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const [reduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    if (reduced) {
      setElapsed(LOOP_MS - 1); // show the finished second purchase
      return;
    }
    const start = performance.now();
    const id = window.setInterval(() => setElapsed((performance.now() - start) % LOOP_MS), 100);
    return () => window.clearInterval(id);
  }, [reduced]);

  const which = elapsed < SECOND_AT ? 0 : 1;
  const p = PURCHASES[which];
  const local = elapsed - (which === 0 ? 0 : SECOND_AT);
  const left = Math.max(0, dailyBudget - spentToday);
  const values = ruleValues({ sellers, perRequestCap, dailyBudget, approvalThreshold, spentToday });

  const gates: Gate[] = [
    {
      ...RULES[0],
      value: values[0],
      ok: sellers.includes(p.seller),
      why: `${p.seller} isn't on your seller list`,
    },
    {
      ...RULES[1],
      value: values[1],
      ok: p.amount <= perRequestCap,
      why: `${usdc(p.amount)} is over your ${usdc(perRequestCap)} per-request limit`,
    },
    {
      ...RULES[2],
      value: values[2],
      ok: p.amount <= left,
      why: `Only ${usdc(left)} is left in today's budget`,
    },
    {
      ...RULES[3],
      value: values[3],
      ok: p.amount <= approvalThreshold,
      soft: true, // failing this one pauses for approval instead of blocking
      why: `${usdc(p.amount)} is over your ${usdc(approvalThreshold)} limit, so it waits for your OK`,
    },
  ];

  // Walk the gates in order; the first failing one ends the walk.
  const stopAt = gates.findIndex((g) => !g.ok);
  const reached = Math.floor((local - GATE_START) / GATE_STEP); // index of the gate being decided
  const states: GateState[] = gates.map((g, i) => {
    if (stopAt !== -1 && i > stopAt) return "idle";
    if (i < reached) return g.ok ? "pass" : g.soft ? "stop" : "block";
    if (i === reached) return "checking";
    return "idle";
  });
  const done = reached > (stopAt === -1 ? gates.length - 1 : stopAt);
  const outcome: "checking" | "paid" | "stop" | "block" = !done ? "checking" : stopAt === -1 ? "paid" : gates[stopAt].soft ? "stop" : "block";

  return (
    <div className="rounded-[22px] border border-line bg-gradient-to-br from-pine/[0.07] via-surface to-surface p-5 sm:p-7">
      {/* Which purchase is being checked */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div key={which} className="msg-in flex min-w-0 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-pine text-white">
            <Coins size={20} />
          </span>
          <div className="min-w-0">
            <p className="text-[18px] font-semibold tracking-[-0.01em]">
              {usdc(p.amount)} <span className="font-normal text-ink-soft">to {p.seller}</span>
            </p>
            <p className="text-[14px] text-muted">{p.what}</p>
          </div>
        </div>
        <div className="flex gap-1 rounded-full bg-paper p-1 text-[13px] font-medium" aria-hidden="true">
          {["Small purchase", "Big purchase"].map((label, i) => (
            <span key={label} className={`rounded-full px-3 py-1 transition-colors ${i === which ? "bg-surface text-ink shadow-sm" : "text-muted"}`}>
              {label}
            </span>
          ))}
        </div>
      </div>

      {/* The four gates */}
      <ol className="mt-6" aria-label="Spending rules, checked in order">
        {gates.map((g, i) => (
          <GateRow key={g.title} gate={g} state={states[i]} last={i === gates.length - 1} filled={states[i] === "pass"} />
        ))}
      </ol>

      {/* Result */}
      <div
        className={`mt-5 flex min-h-[56px] items-center gap-3 rounded-2xl px-4 py-3 text-[15px] transition-colors ${
          outcome === "paid"
            ? "bg-pine/10 text-pine"
            : outcome === "stop"
              ? "bg-hold-soft text-[#8a5d08]"
              : outcome === "block"
                ? "bg-stop/10 text-stop"
                : "bg-paper text-muted"
        }`}
        aria-live="polite"
      >
        {outcome === "checking" && (
          <>
            <span className="h-2 w-2 animate-pulse rounded-full bg-pine/60" /> Checking {usdc(p.amount)} against your rules…
          </>
        )}
        {outcome === "paid" && (
          <>
            <Check size={18} strokeWidth={3} className="shrink-0" />
            <span>
              <b className="font-semibold">All 4 passed.</b> Paid {usdc(p.amount)} on Arc.
            </span>
          </>
        )}
        {outcome === "stop" && (
          <>
            <Hand size={18} className="shrink-0" />
            <span>
              <b className="font-semibold">Paused.</b> {gates[stopAt].why}.
            </span>
          </>
        )}
        {outcome === "block" && (
          <>
            <X size={18} strokeWidth={3} className="shrink-0" />
            <span>
              <b className="font-semibold">Blocked.</b> {gates[stopAt].why}.
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function GateRow({ gate, state, last, filled }: { gate: Gate; state: GateState; last: boolean; filled: boolean }) {
  const { icon: Icon, title, value } = gate;
  const tile =
    state === "pass"
      ? "bg-pine text-white"
      : state === "stop"
        ? "bg-hold-soft text-[#8a5d08] ring-2 ring-hold/40"
        : state === "block"
          ? "bg-stop/10 text-stop ring-2 ring-stop/30"
          : state === "checking"
            ? "bg-surface text-pine ring-2 ring-pine/40"
            : gate.soft
              ? "bg-hold-soft text-[#8a5d08]"
              : "bg-pine-soft text-pine";

  return (
    <li className="relative flex gap-4">
      {/* Icon column with the line down to the next gate */}
      <div className="flex flex-col items-center">
        <span className={`relative z-10 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-all duration-300 ${tile}`}>
          {state === "checking" && <span className="ring absolute inset-0 rounded-2xl bg-pine/20" />}
          <Icon size={22} />
        </span>
        {!last && (
          <span className="relative my-1 w-[2px] flex-1 overflow-hidden rounded-full bg-pine/15">
            <span className={`absolute inset-x-0 top-0 bg-pine transition-[height] duration-700 ${filled ? "h-full" : "h-0"}`} />
          </span>
        )}
      </div>

      <div className={`flex min-w-0 flex-1 items-center justify-between gap-3 ${last ? "" : "pb-6"} pt-1`}>
        <div className="min-w-0">
          <h3 className={`text-[18px] font-semibold transition-colors ${state === "idle" ? "text-ink/70" : "text-ink"}`}>{title}</h3>
          <p className="mt-0.5 text-[15px] text-ink-soft">{value}</p>
        </div>
        <Status state={state} />
      </div>
    </li>
  );
}

function Status({ state }: { state: GateState }) {
  const base = "flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-semibold";
  if (state === "pass")
    return (
      <span className={`chip-pop ${base} bg-pine/10 text-pine`}>
        <Check size={13} strokeWidth={3} /> Passed
      </span>
    );
  if (state === "stop")
    return (
      <span className={`chip-pop ${base} bg-hold-soft text-[#8a5d08]`}>
        <Hand size={13} /> Your OK
      </span>
    );
  if (state === "block")
    return (
      <span className={`chip-pop ${base} bg-stop/10 text-stop`}>
        <X size={13} strokeWidth={3} /> Blocked
      </span>
    );
  if (state === "checking") return <span className={`${base} text-pine`}>Checking…</span>;
  return <span className={`${base} text-muted/70`}>Waiting</span>;
}
