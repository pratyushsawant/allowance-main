// The moment the spending rules visibly work: the agent stopped itself and needs you.
import { useEffect, useRef } from "react";
import { Check, Hand } from "lucide-react";
import { usd } from "../format";
import type { ApprovalRequest, Budget, Rules } from "../types";

type RuleCheck = { ok: boolean; text: string };

function checksFor(req: ApprovalRequest, rules: Rules, spentToday: number, budget: Budget | null): RuleCheck[] {
  const left = budget?.remainingToday ?? rules.dailyBudget - spentToday;
  return [
    { ok: rules.allowlist.includes(req.seller), text: `${req.seller} is on your seller list` },
    { ok: req.amount <= rules.perRequestCap, text: `Under your ${usd(rules.perRequestCap)} USDC per-request limit` },
    { ok: req.amount <= left, text: `Fits today's allowance, ${budget?.remainingTodayLabel ?? usd(left)} USDC left` },
    {
      ok: req.amount <= rules.approvalThreshold,
      text: `Over ${usd(rules.approvalThreshold)} USDC, the amount you asked to approve`,
    },
  ];
}

export function ApprovalModal({
  request,
  rules,
  spentToday,
  budget = null,
  onDecide,
}: {
  request: ApprovalRequest | null;
  rules: Rules | null;
  spentToday: number;
  budget?: Budget | null;
  onDecide: (approve: boolean) => void;
}) {
  const approveRef = useRef<HTMLButtonElement>(null);
  const decideRef = useRef(onDecide);
  useEffect(() => {
    decideRef.current = onDecide;
  });

  // Focus Approve when the request appears; Esc declines.
  useEffect(() => {
    if (!request) return;
    approveRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && decideRef.current(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request]);

  if (!request) return null;
  const checks = rules ? checksFor(request, rules, spentToday, budget) : [];
  const amount = request.amountLabel ?? usd(request.amount);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-title"
      className="takeover-in fixed inset-0 z-50 overflow-y-auto bg-ink/[0.96] text-white backdrop-blur-sm"
    >
      <div className="mx-auto flex min-h-full max-w-[640px] flex-col justify-center px-6 py-10">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-hold text-ink">
            <Hand size={22} strokeWidth={2.25} />
          </span>
          <h2 id="approval-title" className="text-[22px] font-semibold tracking-[-0.01em]">
            Your agent stopped to ask you
          </h2>
        </div>

        <div className="amount-in">
          <div className="flex items-baseline gap-3">
            <span className="text-[112px] font-bold leading-[0.9] tracking-[-0.045em] sm:text-[136px]">{amount}</span>
            <span className="text-[28px] font-semibold text-white/70">USDC</span>
          </div>
          <p className="mt-3 text-[19px] text-white/80">
            to <span className="font-semibold text-white">{request.seller}</span> on Arc Testnet
          </p>
          <p className="mt-2 max-w-[52ch] text-[17px] leading-relaxed text-white/65">{request.reason}</p>
          {request.expiresAt && (
            <p className="mt-2 text-[15px] text-white/55">
              Open until {new Date(request.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Nothing is reserved or paid unless you approve.
            </p>
          )}
        </div>

        {checks.length > 0 && (
          <ul className="mt-8 space-y-2.5 border-t border-white/15 pt-6">
            {checks.map((c, i) => (
              <li
                key={c.text}
                className="check-in flex items-center gap-3 text-[17px]"
                style={{ animationDelay: `${450 + i * 220}ms` }}
              >
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                    c.ok ? "bg-white/12 text-[#8fd3b6]" : "bg-hold text-ink"
                  }`}
                >
                  {c.ok ? <Check size={14} strokeWidth={3} /> : <Hand size={13} strokeWidth={2.5} />}
                </span>
                <span className={c.ok ? "text-white/75" : "font-semibold text-white"}>{c.text}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="check-in mt-9 flex flex-col gap-3 sm:flex-row" style={{ animationDelay: `${450 + checks.length * 220}ms` }}>
          <button
            ref={approveRef}
            onClick={() => onDecide(true)}
            className="flex-1 rounded-2xl bg-white py-4 text-[18px] font-semibold text-ink hover:bg-[#e8f2ed] focus-visible:outline-hold"
          >
            Approve and pay {amount} USDC
          </button>
          <button
            onClick={() => onDecide(false)}
            className="rounded-2xl border border-white/30 px-8 py-4 text-[18px] font-semibold text-white hover:bg-white/10"
          >
            Don't buy
          </button>
        </div>
        <p className="mt-3 text-sm text-white/45">
          Press Esc to decline. Approving or declining asks for the operator code; the assistant can't do either.
        </p>
      </div>
    </div>
  );
}
