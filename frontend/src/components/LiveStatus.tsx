// Live backend status for the demo screen: whether the session is live, whether spending is frozen,
// and the onchain transfers QuickNode Streams reported. All of it comes from the backend; when it
// can't, these say so instead of showing stale or made-up numbers.
import { AlertTriangle, ExternalLink, KeyRound, Radio, Snowflake, WifiOff } from "lucide-react";
import type { Connection, Movement, Rules } from "../types";
import { Card } from "./Card";

export function ConnectionPill({ connection, onConnect }: { connection: Connection; onConnect: () => void }) {
  if (connection === "connected")
    return (
      <span className="hidden items-center gap-1.5 rounded-full bg-pine-soft px-3 py-1 text-sm font-medium text-pine sm:flex">
        <span className="h-2 w-2 rounded-full bg-pine" /> Live
      </span>
    );
  if (connection === "unreachable")
    return (
      <span role="status" className="flex items-center gap-1.5 rounded-full bg-hold-soft px-3 py-1 text-sm font-medium text-[#8a5d08]">
        <WifiOff size={14} /> Can't reach the backend, retrying
      </span>
    );
  return (
    <button
      onClick={onConnect}
      className="flex items-center gap-1.5 rounded-full border border-stop/40 bg-stop/5 px-3 py-1 text-sm font-medium text-stop hover:bg-stop/10"
    >
      <KeyRound size={14} /> {connection === "expired" ? "Session expired · Log in" : "Not connected · Log in"}
    </button>
  );
}

/** Shown on every demo view while spending is frozen, so nobody misses it. */
export function FrozenBanner({ rules }: { rules: Rules | null }) {
  if (!rules?.frozen) return null;
  return (
    <div role="status" className="flex items-start gap-2 border-b border-stop/20 bg-stop/[0.07] px-4 py-2.5 text-[15px] text-stop sm:px-8">
      <Snowflake size={17} className="mt-0.5 shrink-0" />
      <span>
        <b>Spending is frozen.</b> {rules.frozenReason ? `${rules.frozenReason}. ` : ""}The assistant can still chat and look things up, but every
        purchase is refused (nothing is charged) until an operator unfreezes it.
      </span>
    </div>
  );
}

/** Transfers in and out of the agent wallet, as QuickNode Streams delivered them to the backend. */
export function OnchainActivity({ movements }: { movements: Movement[] | null }) {
  return (
    <Card title="Onchain activity" icon={<Radio size={17} />} aside="via QuickNode Streams">
      {movements === null ? (
        <p className="text-sm text-ink-soft">Log in to load the transfers QuickNode Streams has reported.</p>
      ) : movements.length === 0 ? (
        <p className="text-sm text-ink-soft">No transfers involving the agent wallet have been reported yet.</p>
      ) : (
        <ul className="-my-2 divide-y divide-line">
          {movements.slice(0, 8).map((m) => (
            <li key={m.id} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className={`flex items-center gap-1.5 text-[15px] font-medium ${m.alert ? "text-stop" : ""}`}>
                  {m.alert && <AlertTriangle size={15} />}
                  {m.label}
                </p>
                <p className="mt-0.5 text-sm text-muted">
                  {new Date(m.observedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  {m.block !== null && ` · block ${m.block}`}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-[15px] font-semibold">{m.amountLabel} USDC</p>
                <a
                  href={m.explorerUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm font-medium text-usdc underline-offset-4 hover:underline"
                >
                  {m.txHash.slice(0, 8)}…{m.txHash.slice(-6)} <ExternalLink size={13} />
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
