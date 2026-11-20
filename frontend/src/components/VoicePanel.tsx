// Chat with the assistant: typing, plus voice in/out.
// Typed (and browser-transcribed) messages go to the backend's Claude assistant (POST /api/chat),
// which decides what to say; the backend decides whether any purchase may happen.
// Voice: the browser's own speech recognition (Chrome/Edge) and speech synthesis. If the backend
// has ElevenLabs configured, the mic starts an ElevenLabs voice session instead (see VoiceBridge).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Hand, Info, Loader2, Mic, MicOff, Scissors, Sparkles, Square } from "lucide-react";
import type { ChatMessage } from "../types";
import { useVoice, voice } from "../voice";
import { Mark } from "./Landing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SpeechRecognition: any =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;

// Markets that exist on Gemini right now. The first is free; the others ask for paid data.
const SUGGESTIONS = [
  "Hi! What can you do?",
  "What are the BTC odds right now?",
  "How have the Minnesota vs Oklahoma State odds moved?",
  "Get me a deep brief on Minnesota",
];

const clock = (t: number) => `Today at ${new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
const FINAL = new Set(["done", "approval", "incomplete", "error", "canceled", undefined]);

export function VoicePanel({
  messages,
  onSay,
  busy = false,
  onStop,
  title = "Chat with your agent",
  headerRight,
}: {
  messages: ChatMessage[];
  onSay: (text: string) => void;
  busy?: boolean;
  onStop?: () => void;
  title?: string;
  headerRight?: ReactNode;
}) {
  const [browserListening, setListening] = useState(false);
  const v = useVoice();
  const eleven = v.available === true;
  const listening = eleven ? v.status === "connected" || v.status === "connecting" : browserListening;
  // No ElevenLabs and no browser speech recognition (Firefox, Safari without it): typing only.
  const micUnsupported = !eleven && !SpeechRecognition;
  const [typed, setTyped] = useState("");
  const [openedAt] = useState(() => Date.now());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Messages already read aloud (or present when the panel opened, so switching pages doesn't re-read them).
  const spoken = useRef(new Set(messages.map((m) => m.id)));
  // ChatMessage has no timestamp, so remember when each one first appeared.
  const times = useRef(new Map<string, number>());

  // Read each finished answer aloud with the browser's voice, unless ElevenLabs already spoke it.
  useEffect(() => {
    for (const m of messages) {
      if (m.from !== "agent" || !FINAL.has(m.status) || !m.text || spoken.current.has(m.id)) continue;
      spoken.current.add(m.id);
      if (canSpeak && !m.spoken && !voice.connected()) speechSynthesis.speak(new SpeechSynthesisUtterance(m.text));
    }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const toggleMic = () => {
    if (eleven) {
      if (v.status === "connected" || v.status === "connecting") voice.controls()?.stop();
      else voice.controls()?.start();
      return;
    }
    if (!SpeechRecognition) return; // the button is disabled and the note below explains why
    if (browserListening) {
      recRef.current?.stop();
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = "en-US";
    rec.interimResults = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => onSay(e.results[0][0].transcript);
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false); // e.g. microphone permission denied
    rec.start();
    recRef.current = rec;
    setListening(true);
  };

  const submit = () => {
    if (!typed.trim() || busy) return;
    onSay(typed.trim());
    setTyped("");
  };

  const timeOf = (m: ChatMessage) => {
    if (m.at) return m.at;
    if (!times.current.has(m.id)) times.current.set(m.id, Date.now());
    return times.current.get(m.id)!;
  };

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-[18px] border border-line bg-surface">
      <div className="flex min-h-[72px] items-center justify-between gap-3 border-b border-line px-6 py-4 sm:px-7">
        <h2 className="text-[20px] font-semibold tracking-[-0.01em]">{title}</h2>
        {headerRight}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-6 overflow-y-auto px-5 py-6 sm:px-7" aria-live="polite">
        <Message from="agent" time={clock(openedAt)}>
          <p>Hi, I'm your Allowance agent. Ask me about Gemini prediction markets. When you ask for fresh data, I can buy it with a small USDC payment, inside your spending rules; anything over your approval amount waits for you.</p>
          <p className="mt-3">Here are a few things you can ask, or just tap the mic and talk.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                disabled={busy}
                onClick={() => onSay(s)}
                className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-left text-sm text-ink-soft hover:border-ink-soft hover:text-ink"
              >
                <Sparkles size={14} className="shrink-0 text-pine" />
                {s}
              </button>
            ))}
          </div>
        </Message>

        {messages.map((m) =>
          m.from === "system" ? (
            <Notice key={m.id} text={m.text} warn={m.status === "error"} time={clock(timeOf(m))} />
          ) : (
          <Message key={m.id} from={m.from} time={clock(timeOf(m))} tone={m.status}>
            {m.status === "thinking" || m.status === "fetching" ? (
              <span className="flex items-center gap-2 text-ink-soft">
                <Loader2 size={16} className="animate-spin" />
                {m.status === "fetching" ? "Fetching data…" : "Thinking…"}
              </span>
            ) : (
              <>
                <span className="whitespace-pre-line">{m.text}</span>
                {m.status === "approval" && (
                  <span className="mt-2 flex w-fit items-center gap-1.5 rounded-full bg-hold-soft px-2.5 py-0.5 text-[13px] font-semibold text-[#8a5d08]">
                    <Hand size={14} /> Waiting for your approval
                  </span>
                )}
                {m.status === "incomplete" && (
                  <span className="mt-2 flex w-fit items-center gap-1.5 rounded-full bg-paper px-2.5 py-0.5 text-[13px] font-semibold text-ink-soft ring-1 ring-line">
                    <Scissors size={13} /> Answer cut short. Ask again or narrow the question.
                  </span>
                )}
              </>
            )}
          </Message>
          ),
        )}
      </div>

      <div className="border-t border-line px-5 pb-4 pt-4 sm:px-7">
        <div className="flex items-center gap-3">
          <div className="relative flex h-14 w-14 shrink-0 items-center justify-center">
            {listening && (
              <>
                <span className="ring absolute inset-0 rounded-full bg-pine" />
                <span className="ring ring-delay absolute inset-0 rounded-full bg-pine" />
              </>
            )}
            <button
              onClick={toggleMic}
              disabled={micUnsupported}
              aria-label={micUnsupported ? "Voice input isn't supported in this browser" : listening ? "Stop listening" : "Start talking"}
              title={micUnsupported ? "Voice input needs Chrome or Edge (or ElevenLabs configured on the backend). Type instead." : undefined}
              aria-pressed={listening}
              className={`relative flex h-14 w-14 items-center justify-center rounded-full text-white shadow-[0_8px_20px_-8px_rgba(29,79,145,0.7)] transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-line disabled:text-muted disabled:shadow-none disabled:active:scale-100 ${
                listening ? "bg-ink" : "bg-pine hover:scale-[1.04]"
              }`}
            >
              {micUnsupported ? <MicOff size={22} /> : listening ? <Square size={20} fill="currentColor" /> : <Mic size={24} />}
            </button>
          </div>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder={listening ? "Listening…" : "Ask anything about the markets…"}
            aria-label="Type a question"
            className="h-14 min-w-0 flex-1 rounded-xl border border-line px-4 text-[16px] outline-none placeholder:text-muted focus:border-ink-soft"
          />
          {busy && onStop ? (
            <button
              onClick={onStop}
              className="flex h-14 shrink-0 items-center gap-1.5 rounded-xl border border-line px-5 text-[16px] font-semibold text-ink-soft hover:border-ink-soft hover:text-ink"
            >
              <Square size={14} fill="currentColor" /> Stop
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!typed.trim() || busy}
              className="h-14 shrink-0 rounded-xl bg-pine px-6 text-[16px] font-semibold text-white hover:bg-[#163f75] disabled:bg-pine-soft disabled:text-pine/50"
            >
              Send
            </button>
          )}
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-muted">
          {eleven && v.status === "connecting"
            ? "Connecting to the ElevenLabs voice agent…"
            : listening
              ? eleven
                ? "Talking with the ElevenLabs voice agent. Tap the square to end the call."
                : "Listening. Tap the square to stop."
              : "Only paid data requests spend your allowance, and each is checked against your rules. The assistant's AI usage is billed separately to the project's Anthropic account. Answers are for information only, not financial advice."}
        </p>
        <p className="mt-1 text-[12px] text-muted">
          {eleven
            ? "Voice: ElevenLabs agent (it can look things up; purchases go through the chat assistant)."
            : micUnsupported
              ? "Voice input isn't available in this browser (it needs Chrome or Edge), and ElevenLabs isn't configured on the backend. Type instead."
              : v.available === false
                ? "Voice: browser speech recognition and read-aloud (ElevenLabs isn't configured on the backend)."
                : "Voice: browser speech recognition and read-aloud."}
          {v.error && <span className="text-stop"> {v.error}</span>}
        </p>
      </div>
    </section>
  );
}

function Message({ from, time, tone, children }: { from: "user" | "agent"; time: string; tone?: ChatMessage["status"]; children: ReactNode }) {
  return (
    <div className="msg-in flex items-end gap-3">
      {from === "agent" ? (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-pine">
          <Mark size={20} light />
        </span>
      ) : (
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink text-xs font-semibold text-white">You</span>
      )}
      <div className="min-w-0 max-w-[85%]">
        <div className="mb-1.5 flex items-center gap-1.5 text-sm text-muted">
          <span>{from === "agent" ? "Allowance" : "You"}</span>
          {from === "agent" && <span className="rounded bg-paper px-1.5 text-[11px] font-semibold text-ink-soft">AI</span>}
          <span aria-hidden="true">•</span>
          <span>{time}</span>
        </div>
        <div
          className={`rounded-xl px-4 py-3 text-[16px] leading-relaxed ${
            from === "user"
              ? "bg-usdc-soft text-ink"
              : tone === "error"
                ? "border border-stop/30 bg-stop/5 text-ink"
                : tone === "canceled"
                  ? "bg-paper text-ink-soft"
                  : "bg-paper text-ink"
          }`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

// An app notice (freeze changes, onchain transfers, session state): not written by the AI.
function Notice({ text, warn, time }: { text: string; warn: boolean; time: string }) {
  const Icon = warn ? AlertTriangle : Info;
  return (
    <div role="status" className={`msg-in mx-auto flex max-w-[92%] items-start gap-2 rounded-lg px-3 py-2 text-[14px] leading-relaxed ${warn ? "bg-hold-soft text-[#6b4806]" : "bg-paper text-ink-soft"}`}>
      <Icon size={15} className="mt-[3px] shrink-0" />
      <span>
        <span className="font-semibold">Allowance app</span> · {time}
        <br />
        {text}
      </span>
    </div>
  );
}
