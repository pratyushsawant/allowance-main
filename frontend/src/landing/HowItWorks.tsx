// "How it works": four steps on the left that advance on their own, and a phone on
// the right showing each step as it happens. Hover pauses, click jumps to a step.
// Colors come from the theme tokens in src/index.css (pine = brand blue).
import { useState } from "react";
import { Check, Coins, Mic, ShieldCheck, Volume2, type LucideIcon } from "lucide-react";

const STEP_MS = 4500;

type Step = {
  icon: LucideIcon;
  title: string;
  body: string;
  note: { app: string; title: string; text: string }; // the phone notification for this step
};

const STEPS: Step[] = [
  {
    icon: Mic,
    title: "You ask out loud",
    body: "Speak or type a question about any prediction market.",
    note: { app: "Allowance", title: "Listening", text: "“What are the odds BTC closes above 100k?”" },
  },
  {
    icon: ShieldCheck,
    title: "Your rules check the price",
    body: "Seller list, per-request limit, daily budget. Over your approval amount, the agent stops and asks you.",
    note: { app: "Spending rules", title: "All 4 rules passed", text: "0.005 USDC is within your limits" },
  },
  {
    icon: Coins,
    title: "It pays on Arc",
    body: "A small USDC payment goes to the data seller, and you watch it settle live.",
    note: { app: "Arc Testnet", title: "Payment settled", text: "−0.005 USDC to Odds Desk" },
  },
  {
    icon: Volume2,
    title: "You hear the answer",
    body: "The agent reads back what it bought and what it cost.",
    note: { app: "Allowance", title: "Answer ready", text: "Example answer, read back with what it cost" },
  },
];

export function HowItWorks() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  // With reduced motion, steps don't advance on their own (and the global CSS would
  // otherwise shorten the progress animation to 1ms and cycle steps instantly).
  const [reduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const next = () => setActive((a) => (a + 1) % STEPS.length);

  return (
    <section id="how-it-works" className="scroll-mt-16 bg-surface">
      <div className="mx-auto grid max-w-[1600px] items-center gap-14 px-4 py-24 sm:px-8 lg:grid-cols-[minmax(0,700px)_minmax(0,1fr)] lg:gap-12">
        <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
          <h2 className="max-w-[20ch] text-[36px] font-bold leading-[1.08] tracking-[-0.03em] sm:text-[44px]">
            From a question to an answer in four steps
          </h2>

          <ol className="mt-12 space-y-1.5">
            {STEPS.map(({ icon: Icon, title, body }, i) => {
              const on = i === active;
              return (
                <li key={title}>
                  <button
                    onClick={() => setActive(i)}
                    aria-current={on ? "step" : undefined}
                    className={`relative w-full overflow-hidden rounded-2xl px-5 py-5 text-left transition-colors ${
                      on ? "bg-paper" : "hover:bg-paper/50"
                    }`}
                  >
                    <div className="flex gap-4">
                      <span
                        className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl transition-colors ${
                          on ? "bg-pine text-white" : "bg-pine/10 text-pine"
                        }`}
                      >
                        <Icon size={22} strokeWidth={1.9} />
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-pine">Step {i + 1}</p>
                        <h3 className="mt-0.5 text-[21px] font-semibold tracking-[-0.01em]">{title}</h3>
                        <p className={`mt-1.5 max-w-[52ch] text-[16px] leading-relaxed transition-colors ${on ? "text-ink-soft" : "text-muted"}`}>
                          {body}
                        </p>
                      </div>
                    </div>

                    {on && (
                      <span className="absolute inset-x-5 bottom-0 h-[3px] overflow-hidden rounded-full bg-pine/15" aria-hidden="true">
                        <span
                          key={active}
                          className={`block h-full bg-pine ${reduced ? "w-full" : "step-progress"}`}
                          style={{ animationDuration: `${STEP_MS}ms`, animationPlayState: paused ? "paused" : "running" }}
                          onAnimationEnd={reduced ? undefined : next}
                        />
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>

        <Phone active={active} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The phone: notifications at the top (two newest only), the step's screen below.
// ---------------------------------------------------------------------------
function Phone({ active }: { active: number }) {
  const notes = STEPS.slice(0, active + 1)
    .map((s, i) => ({ ...s.note, icon: s.icon, i }))
    .slice(-2)
    .reverse(); // newest first

  return (
    <div className="mx-auto w-full max-w-[300px]" aria-label={`Phone showing step ${active + 1}`} role="img">
      <div className="relative aspect-[9/18.5] w-full rounded-[46px] border-[9px] border-ink bg-ink shadow-[0_40px_80px_-30px_rgba(19,33,46,0.45)]">
        <div className="relative flex h-full flex-col overflow-hidden rounded-[37px] bg-paper">
          {/* Status bar + island */}
          <div className="flex items-center justify-between px-6 pt-3 text-[12px] font-semibold">
            <span>9:41</span>
            <span className="absolute left-1/2 top-2.5 h-[22px] w-[86px] -translate-x-1/2 rounded-full bg-ink" />
            <span className="flex items-center gap-1">
              <span className="h-2 w-3 rounded-[2px] bg-ink/80" />
              <span className="h-2.5 w-5 rounded-[3px] border border-ink/70 p-[1.5px]">
                <span className="block h-full w-3/4 rounded-[1px] bg-ink/80" />
              </span>
            </span>
          </div>

          {/* Notifications: only the two newest */}
          <ul className="mt-6 h-[150px] space-y-2 px-3">
            {notes.map((n, k) => {
              const Icon = n.icon;
              return (
                <li
                  key={n.i}
                  className={`note-in rounded-2xl bg-surface/95 p-3 shadow-[0_6px_18px_-10px_rgba(19,33,46,0.35)] transition-all duration-300 ${
                    k === 1 ? "scale-[0.96] opacity-60" : ""
                  }`}
                >
                  <div className="flex items-center gap-2 text-[11px] text-muted">
                    <span className="flex h-5 w-5 items-center justify-center rounded-md bg-pine/10 text-pine">
                      <Icon size={12} />
                    </span>
                    <span className="font-semibold text-ink-soft">{n.app}</span>
                    <span className="ml-auto">{k === 0 ? "now" : "1s ago"}</span>
                  </div>
                  <p className="mt-1.5 text-[13px] font-semibold leading-tight">{n.title}</p>
                  <p className="mt-0.5 truncate text-[12px] text-ink-soft">{n.text}</p>
                </li>
              );
            })}
          </ul>

          {/* The step's screen */}
          <div key={active} className="msg-in flex flex-1 flex-col items-center justify-center px-5 pb-10">
            <Screen step={active} />
          </div>

          <span className="absolute bottom-2 left-1/2 h-1 w-28 -translate-x-1/2 rounded-full bg-ink/80" />
        </div>
      </div>
    </div>
  );
}

function Screen({ step }: { step: number }) {
  if (step === 0)
    return (
      <>
        <span className="relative flex h-20 w-20 items-center justify-center">
          <span className="ring absolute inset-0 rounded-full bg-pine" />
          <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-pine text-white">
            <Mic size={32} />
          </span>
        </span>
        <Wave className="mt-6" />
        <p className="mt-3 text-[14px] font-medium text-ink-soft">Listening…</p>
      </>
    );

  if (step === 1)
    return (
      <div className="w-full rounded-2xl bg-surface p-4">
        <p className="text-[13px] font-semibold">Checking 0.005 USDC</p>
        <ul className="mt-3 space-y-2.5">
          {["Odds Desk is on your list", "Under 1.00 USDC per request", "Fits today's 5.00 USDC budget", "Under your 0.25 USDC ask-me limit"].map((r, i) => (
            <li key={r} className="check-in flex items-center gap-2.5 text-[12.5px]" style={{ animationDelay: `${200 + i * 350}ms` }}>
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-pine text-white">
                <Check size={12} strokeWidth={3} />
              </span>
              {r}
            </li>
          ))}
        </ul>
      </div>
    );

  if (step === 2)
    return (
      <div className="w-full rounded-2xl bg-surface p-5 text-center">
        <p className="text-[38px] font-bold leading-none tracking-[-0.03em]">−0.005</p>
        <p className="mt-1 text-[13px] font-medium text-ink-soft">USDC to Odds Desk</p>
        <span
          className="chip-pop mx-auto mt-4 flex w-fit items-center gap-1 rounded-full bg-pine/10 px-3 py-1 text-[12px] font-semibold text-pine"
          style={{ animationDelay: "900ms" }}
        >
          <Check size={12} strokeWidth={3} /> Settled on Arc
        </span>
        <p className="mt-3 font-mono text-[11px] text-muted">Arc tx 0x6e67…c957ec</p>
      </div>
    );

  return (
    <>
      <p className="text-[56px] font-bold leading-none tracking-[-0.04em] text-pine">62%</p>
      <p className="mt-2 text-center text-[13px] text-ink-soft">chance yes (example market)</p>
      <div className="mt-6 flex items-center gap-2 rounded-full bg-surface px-4 py-2">
        <Volume2 size={16} className="text-pine" />
        <Wave small />
      </div>
      <p className="mt-3 text-[12px] text-muted">Paid 0.005 USDC for this answer</p>
    </>
  );
}

// Animated sound wave in the brand color.
function Wave({ small = false, className = "" }: { small?: boolean; className?: string }) {
  const heights = small ? [6, 12, 9, 14, 7, 11, 5, 10] : [10, 22, 16, 30, 20, 34, 14, 26, 18, 30, 12, 20, 8];
  return (
    <span className={`flex items-center gap-[3px] ${className}`} aria-hidden="true">
      {heights.map((h, i) => (
        <span key={i} className="wave-bar w-[3px] rounded-full bg-pine" style={{ height: h, animationDelay: `${i * 90}ms` }} />
      ))}
    </span>
  );
}
