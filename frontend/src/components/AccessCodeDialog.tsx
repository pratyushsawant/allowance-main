// Asks for an access code when the backend needs a session. Codes are typed at runtime and sent
// only to POST /api/sessions; nothing is stored. The operator code is asked for only when a person
// approves, declines, freezes or unfreezes.
import { useEffect, useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { setAccessCodePrompt, type Scope } from "../backend";

type Ask = { scope: Scope; error?: string; resolve: (code: string | null) => void };

const COPY: Record<Scope, { title: string; body: string }> = {
  agent: { title: "Connect to Allowance", body: "Enter the demo access code to let the agent look up markets and buy data within your rules." },
  operator: { title: "Operator check", body: "Approving, declining or freezing spending needs the operator code. The agent never sees it." },
};

export function AccessCodeDialog() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [code, setCode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAccessCodePrompt(
      (scope, error) =>
        new Promise((resolve) => {
          setCode("");
          setAsk({ scope, error, resolve });
        }),
    );
    return () => setAccessCodePrompt(async () => null);
  }, []);

  useEffect(() => {
    if (ask) inputRef.current?.focus();
  }, [ask]);

  if (!ask) return null;
  const finish = (value: string | null) => {
    ask.resolve(value);
    setAsk(null);
    setCode("");
  };
  const copy = COPY[ask.scope];

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="access-title" className="fixed inset-0 z-[60] flex items-center justify-center bg-ink/70 px-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) finish(code.trim());
        }}
        className="w-full max-w-[420px] rounded-2xl bg-surface p-6 shadow-xl"
      >
        <div className="mb-3 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-pine-soft text-pine">
            <KeyRound size={18} />
          </span>
          <h2 id="access-title" className="text-[19px] font-semibold">
            {copy.title}
          </h2>
        </div>
        <p className="text-[15px] leading-relaxed text-ink-soft">{copy.body}</p>
        <input
          ref={inputRef}
          type="password"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && finish(null)}
          aria-label={`${ask.scope} access code`}
          placeholder="Access code"
          className="mt-4 h-12 w-full rounded-xl border border-line px-4 text-[16px] outline-none placeholder:text-muted focus:border-ink-soft"
        />
        {ask.error && (
          <p role="alert" className="mt-2 text-sm text-stop">
            {ask.error}
          </p>
        )}
        <div className="mt-5 flex gap-2">
          <button type="submit" disabled={!code.trim()} className="h-11 flex-1 rounded-xl bg-pine font-semibold text-white hover:bg-[#163f75] disabled:bg-pine-soft disabled:text-pine/50">
            Continue
          </button>
          <button type="button" onClick={() => finish(null)} className="h-11 rounded-xl border border-line px-5 font-medium text-ink-soft hover:text-ink">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
