import { useEffect, useState } from "react";
import { CalendarClock, Check, Hand, Lock, Plus, Receipt, ShieldCheck, Snowflake, Store, X } from "lucide-react";
import type { Rules } from "../types";
import { Card } from "./Card";
import { USE_MOCK } from "../config";

const usdc = (n: number) => `${Number(n.toFixed(3))} USDC`;

export function RulesPanel({
  rules,
  onSave,
  onSetFrozen,
}: {
  rules: Rules | null;
  onSave: (r: Rules) => Promise<void>;
  onSetFrozen?: (frozen: boolean) => Promise<void>;
}) {
  if (rules && rules.editable === false) return <ServerRules rules={rules} onSetFrozen={onSetFrozen} />;
  if (!USE_MOCK)
    return (
      <Card title="Spending rules" icon={<ShieldCheck size={17} />}>
        <p className="text-[15px] leading-relaxed text-ink-soft">
          Log in to load the spending rules from the backend. They're enforced on the server for every purchase, so this page shows them but can't change them.
        </p>
      </Card>
    );
  // Mock mode only: editable rules for the offline demo.
  return <EditableRules rules={rules} onSave={onSave} />;
}

// The real backend: limits are server config, so they're shown, not edited. The person can still
// stop all spending with the freeze switch (operator code required).
function ServerRules({ rules, onSetFrozen }: { rules: Rules; onSetFrozen?: (frozen: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    if (!onSetFrozen) return;
    setBusy(true);
    await onSetFrozen(!rules.frozen);
    setBusy(false);
  };
  const row = (icon: React.ReactNode, text: React.ReactNode) => (
    <p className="flex items-center gap-2 py-1.5 text-[15px] text-ink">
      <span className="text-ink-soft">{icon}</span>
      {text}
    </p>
  );
  return (
    <Card title="Spending rules" icon={<ShieldCheck size={17} />}>
      {rules.frozen && (
        <p role="status" className="mb-3 rounded-lg bg-stop/10 px-3 py-2 text-sm text-stop">
          Spending is frozen{rules.frozenReason ? `: ${rules.frozenReason}` : ""}. The agent can't buy anything.
        </p>
      )}
      <div className="space-y-0.5">
        {row(<Receipt size={16} />, <>Pay up to <b>{usdc(rules.perRequestCap)}</b> per request</>)}
        {row(<CalendarClock size={16} />, <>Spend up to <b>{usdc(rules.dailyBudget)}</b> a day</>)}
        {row(<Hand size={16} />, <>Ask me before anything over <b>{usdc(rules.approvalThreshold)}</b></>)}
      </div>
      <div className="mt-4 border-t border-line pt-4">
        <p className="mb-2 flex items-center gap-2 text-[15px] text-ink">
          <Store size={16} className="text-ink-soft" /> Only pay these sellers
        </p>
        <div className="flex flex-wrap gap-1.5">
          {rules.allowlist.length === 0 && <span className="text-sm text-ink-soft">The backend didn't report its seller list.</span>}
          {rules.allowlist.map((s) => (
            <span key={s} className="rounded-lg bg-paper px-2.5 py-1 text-sm font-medium">
              {s}
            </span>
          ))}
        </div>
      </div>
      <p className="mt-4 flex items-start gap-1.5 text-[13px] leading-relaxed text-muted">
        <Lock size={13} className="mt-0.5 shrink-0" />
        These limits are enforced by the backend on every payment; a browser can't raise them.
      </p>
      {onSetFrozen && (
        <button
          onClick={toggle}
          disabled={busy}
          className={`mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-[15px] font-semibold disabled:opacity-60 ${
            rules.frozen ? "bg-pine text-white hover:bg-[#163f75]" : "border border-stop text-stop hover:bg-stop/10"
          }`}
        >
          <Snowflake size={16} /> {busy ? "Working…" : rules.frozen ? "Unfreeze spending" : "Freeze all spending"}
        </button>
      )}
    </Card>
  );
}

function EditableRules({ rules, onSave }: { rules: Rules | null; onSave: (r: Rules) => Promise<void> }) {
  const [draft, setDraft] = useState<Rules | null>(rules);
  const [newSeller, setNewSeller] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(rules), [rules]);
  if (!draft)
    return (
      <Card title="Spending rules">
        <p className="text-sm text-ink-soft">Loading your rules…</p>
      </Card>
    );

  const setNum = (key: "perRequestCap" | "dailyBudget" | "approvalThreshold") => (n: number) => {
    setSaved(false);
    setDraft({ ...draft, [key]: n });
  };

  const addSeller = () => {
    const s = newSeller.trim();
    if (s && !draft.allowlist.includes(s)) {
      setSaved(false);
      setDraft({ ...draft, allowlist: [...draft.allowlist, s] });
    }
    setNewSeller("");
  };

  const changed = JSON.stringify(draft) !== JSON.stringify(rules);

  return (
    <Card title="Spending rules" icon={<ShieldCheck size={17} />} aside="Mock mode">
      <p className="mb-3 rounded-lg bg-hold-soft px-3 py-2 text-sm text-[#8a5d08]">Offline demo: these edits only change the mock. The real backend's rules are server config.</p>
      <div className="space-y-1">
        <RuleLine icon={<Receipt size={16} />} before="Pay up to" value={draft.perRequestCap} after="per request" onChange={setNum("perRequestCap")} />
        <RuleLine icon={<CalendarClock size={16} />} before="Spend up to" value={draft.dailyBudget} after="a day" onChange={setNum("dailyBudget")} />
        <RuleLine
          icon={<Hand size={16} />}
          before="Ask me before anything over"
          value={draft.approvalThreshold}
          onChange={setNum("approvalThreshold")}
          accent
        />
      </div>

      <div className="mt-4 border-t border-line pt-4">
        <p className="mb-2 flex items-center gap-2 text-[15px] text-ink">
          <Store size={16} className="text-ink-soft" /> Only pay these sellers
        </p>
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {draft.allowlist.length === 0 && <span className="text-sm text-stop">No sellers allowed. Your agent can't buy anything.</span>}
          {draft.allowlist.map((s) => (
            <span key={s} className="flex items-center gap-1 rounded-lg bg-paper py-1 pl-2.5 pr-1.5 text-sm font-medium">
              {s}
              <button
                aria-label={`Remove ${s}`}
                onClick={() => {
                  setSaved(false);
                  setDraft({ ...draft, allowlist: draft.allowlist.filter((x) => x !== s) });
                }}
                className="rounded p-0.5 text-muted hover:bg-line hover:text-ink"
              >
                <X size={14} />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            value={newSeller}
            onChange={(e) => setNewSeller(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addSeller()}
            placeholder="Seller name or address"
            aria-label="Add a seller"
            className="min-w-0 flex-1 rounded-lg border border-line px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-ink-soft"
          />
          <button
            onClick={addSeller}
            className="flex items-center gap-1 rounded-lg border border-line px-3 text-sm font-medium text-ink-soft hover:border-ink-soft hover:text-ink"
          >
            <Plus size={15} /> Add
          </button>
        </div>
      </div>

      <button
        disabled={!changed || saving}
        onClick={async () => {
          setSaving(true);
          await onSave(draft);
          setSaving(false);
          setSaved(true);
        }}
        className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-xl bg-pine py-2.5 text-[15px] font-semibold text-white hover:bg-[#163f75] disabled:cursor-default disabled:bg-paper disabled:text-muted"
      >
        {saving ? "Saving…" : saved && !changed ? (<><Check size={16} /> Rules saved</>) : "Save rules"}
      </button>
    </Card>
  );
}

function RuleLine({
  icon,
  before,
  value,
  after,
  onChange,
  accent = false,
}: {
  icon: React.ReactNode;
  before: string;
  value: number;
  after?: string;
  onChange: (n: number) => void;
  accent?: boolean;
}) {
  // Keep the typed text locally so "0.50" doesn't collapse to "0.5" mid-edit.
  const [text, setText] = useState(value.toFixed(2));
  useEffect(() => {
    if (Number(text) !== value) setText(value.toFixed(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <label className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 text-[15px]">
      <span className={accent ? "text-[#8a5d08]" : "text-ink-soft"}>{icon}</span>
      <span>{before}</span>
      <span
        className={`inline-flex items-center rounded-lg border px-2 focus-within:border-ink-soft ${
          accent ? "border-hold/50 bg-hold-soft" : "border-line bg-paper"
        }`}
      >
        <input
          inputMode="decimal"
          value={text}
          onChange={(e) => {
            const t = e.target.value.replace(/[^0-9.]/g, "");
            setText(t);
            if (t !== "" && !Number.isNaN(Number(t))) onChange(Number(t));
          }}
          onBlur={() => setText(value.toFixed(2))}
          className="w-14 bg-transparent py-1 text-right font-semibold outline-none"
        />
        <span className="ml-1 text-sm text-ink-soft">USDC</span>
      </span>
      {after && <span>{after}</span>}
    </label>
  );
}
