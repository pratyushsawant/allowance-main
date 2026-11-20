// The live demo as an app: sidebar with the allowance, a payments list beside the chat
// (where you watch each USDC payment settle), plus Payments and Rules views.
import { useState } from "react";
import { House, LineChart, Plus, Receipt, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import { USE_MOCK } from "../config";
import { usd } from "../format";
import type { useAllowance } from "../useAllowance";
import { BudgetMeter } from "./BudgetMeter";
import { Mark, type Page } from "./Landing";
import { ConnectionPill, FrozenBanner, OnchainActivity } from "./LiveStatus";
import { PaymentFeed } from "./PaymentFeed";
import { RulesPanel } from "./RulesPanel";
import { VoicePanel } from "./VoicePanel";

type View = "assistant" | "payments" | "rules";
const VIEWS: { id: View; label: string; title: string; icon: typeof Sparkles }[] = [
  { id: "assistant", label: "Assistant", title: "Assistant", icon: Sparkles },
  { id: "payments", label: "Payments", title: "Payments", icon: Receipt },
  { id: "rules", label: "Spending rules", title: "Spending rules", icon: ShieldCheck },
];

export function DemoPage({ a, go }: { a: ReturnType<typeof useAllowance>; go: (p: Page, section?: string) => void }) {
  const [view, setView] = useState<View>("assistant");
  // Prefer the backend's exact figures; fall back to the rules (mock mode / before login).
  const budget = a.budget?.dailyCap ?? a.rules?.dailyBudget ?? 0;
  const left = a.budget?.remainingToday ?? Math.max(0, budget - a.spentToday);
  const paidCount = a.payments.filter((p) => p.status === "confirmed").length;
  const current = VIEWS.find((v) => v.id === view)!;

  return (
    <div className="flex min-h-screen bg-paper lg:h-screen">
      {/* Sidebar */}
      <aside className="hidden w-[272px] shrink-0 flex-col bg-[#1d4f91] text-white lg:flex">
        <div className="flex h-[76px] items-center border-b border-white/10 px-6">
          <button onClick={() => go("home", "top")} className="flex items-center gap-2.5 text-[21px] font-bold tracking-[-0.02em]">
            <Mark light /> Allowance
          </button>
        </div>

        <button onClick={() => setView("rules")} className="mx-3 mt-4 rounded-xl bg-white/10 p-4 text-left hover:bg-white/[0.14]">
          <div className="flex items-baseline justify-between">
            <span className="text-[16px] font-semibold">Today's allowance</span>
            <span className="text-sm text-white/75">{a.budget?.remainingTodayLabel ?? usd(left)} left</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/15">
            <div
              className="h-full rounded-full bg-[#f3ede3] transition-[width] duration-500"
              style={{ width: `${budget > 0 ? (left / budget) * 100 : 0}%` }}
            />
          </div>
          <div className="mt-2 text-xs text-white/60">
            of {a.budget?.dailyCapLabel ?? usd(budget)} USDC a day{a.rules?.frozen ? " · frozen" : ""}
          </div>
        </button>

        <nav className="mt-4 flex-1 space-y-1 px-3" aria-label="Demo">
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              aria-current={view === id ? "page" : undefined}
              className={`flex w-full items-center gap-4 rounded-lg px-4 py-3 text-[17px] ${
                view === id ? "bg-[#163f75] font-semibold text-white" : "text-white/85 hover:bg-white/10"
              }`}
            >
              <Icon size={20} />
              <span className="flex-1 text-left">{label}</span>
              {id === "payments" && paidCount > 0 && (
                <span className="rounded-md bg-[#4a90e2] px-2 py-0.5 text-xs font-semibold">{paidCount}</span>
              )}
            </button>
          ))}
          <div className="my-3 border-t border-white/10" />
          <button onClick={() => go("markets")} className="flex w-full items-center gap-4 rounded-lg px-4 py-3 text-[17px] text-white/85 hover:bg-white/10">
            <LineChart size={20} /> Markets
          </button>
          <button onClick={() => go("home", "how-it-works")} className="flex w-full items-center gap-4 rounded-lg px-4 py-3 text-[17px] text-white/85 hover:bg-white/10">
            <House size={20} /> How it works
          </button>
        </nav>

        <div className="flex items-center gap-3 border-t border-white/10 px-6 py-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15">
            <span className="relative flex h-2.5 w-2.5">
              <span className="ring absolute inset-0 rounded-full bg-[#f3ede3]" />
              <span className="relative h-2.5 w-2.5 rounded-full bg-[#f3ede3]" />
            </span>
          </span>
          <div className="leading-tight">
            <div className="text-[16px] font-semibold">Agent wallet</div>
            <div className="text-sm text-white/65">
              {USE_MOCK
                ? "Demo data"
                : a.budget?.availableFundsLabel != null
                  ? `${a.budget.availableFundsLabel} USDC in Gateway · Arc Testnet`
                  : a.connection === "connected"
                    ? "Gateway balance unavailable"
                    : "Log in to see the balance"}
            </div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[76px] shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4 sm:px-8">
          <div className="flex items-center gap-3">
            <button onClick={() => go("home", "top")} className="lg:hidden" aria-label="Allowance home">
              <Mark />
            </button>
            <h1 className="text-[24px] font-semibold tracking-[-0.02em]">{current.title}</h1>
          </div>
          <div className="flex items-center gap-2">
            {!USE_MOCK && <ConnectionPill connection={a.connection} onConnect={() => void a.connect()} />}
            {USE_MOCK && (
              <span className="hidden rounded-full border border-hold/40 bg-hold-soft px-3 py-1 text-sm font-medium text-[#8a5d08] sm:inline">
                Demo data
              </span>
            )}
            <button
              onClick={() => {
                a.clearChat();
                setView("assistant");
              }}
              className="flex items-center gap-1.5 rounded-lg bg-pine px-4 py-2.5 text-[15px] font-semibold text-white hover:bg-[#163f75]"
            >
              <Plus size={17} /> New chat
            </button>
          </div>
        </header>

        <FrozenBanner rules={a.rules} />

        {/* Phone/tablet: views as tabs instead of the sidebar */}
        <div className="flex gap-1 overflow-x-auto border-b border-line bg-surface px-3 py-2 lg:hidden">
          {VIEWS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              aria-current={view === id ? "page" : undefined}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${
                view === id ? "bg-[#1d4f91] text-white" : "text-ink-soft"
              }`}
            >
              <Icon size={16} /> {label}
            </button>
          ))}
          <button onClick={() => go("markets")} className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-ink-soft">
            <LineChart size={16} /> Markets
          </button>
        </div>

        <main className="min-h-0 flex-1 p-4 sm:p-6 lg:p-8">
          {view === "assistant" && (
            <div className="grid h-full grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(360px,0.8fr)_minmax(0,1.6fr)] lg:gap-8">
              <div className="order-2 lg:order-1 lg:min-h-0">
                <PaymentFeed payments={a.payments} />
              </div>
              <div className="order-1 h-[680px] lg:order-2 lg:h-auto lg:min-h-0">
                <VoicePanel
                  messages={a.messages}
                  onSay={a.say}
                  busy={a.busy}
                  onStop={a.stop}
                  title={a.messages.length ? "Today's chat" : "New chat"}
                  headerRight={
                    a.messages.length > 0 && (
                      <button
                        onClick={a.clearChat}
                        className="flex items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 text-[15px] font-medium text-stop hover:border-stop/50"
                      >
                        <Trash2 size={15} /> Clear
                      </button>
                    )
                  }
                />
              </div>
            </div>
          )}

          {view === "payments" && (
            <div className="grid h-full grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)] lg:gap-8">
              <div className="lg:min-h-0">
                <PaymentFeed payments={a.payments} />
              </div>
              <div className="space-y-6">
                <BudgetMeter spent={a.spentToday} budget={a.budget} dailyCap={budget} payments={a.payments} />
                {!USE_MOCK && <OnchainActivity movements={a.movements} />}
              </div>
            </div>
          )}

          {view === "rules" && (
            <div className="grid max-w-[1100px] grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2 lg:gap-8">
              <RulesPanel rules={a.rules} onSave={a.saveRules} onSetFrozen={a.setFrozen} />
              <div className="space-y-6">
                <BudgetMeter spent={a.spentToday} budget={a.budget} dailyCap={budget} payments={a.payments} />
                <p className="rounded-2xl border border-line bg-surface p-5 text-[15px] leading-relaxed text-ink-soft">
                  Your agent checks every purchase against these rules before paying. Anything over your approval amount pauses
                  the agent until you say yes.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
