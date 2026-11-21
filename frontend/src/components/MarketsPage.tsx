// Markets page: one asset at a time with live prices, a chart, key indicators, and the
// real prediction markets about it. Questions go to the agent drawer.
// Data: src/marketsApi.ts (CoinGecko, Yahoo Finance, Polymarket). Colors: theme tokens
// in src/index.css (pine = brand blue); green/red only for price up/down.
import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, ExternalLink, FileText, Maximize2, MessageCircle, Mic, RefreshCw, Search, TrendingDown, TrendingUp, Wallet, X } from "lucide-react";
import type { ChatMessage, InputVia } from "../types";
import { WATCHLIST, compact, formatPrice, pctChange, type AssetData, type AssetMeta, type Point } from "../markets";
import { useMarketData } from "../marketsApi";
import { VoicePanel } from "./VoicePanel";
import { usd } from "../format";

const RANGES = [
  { label: "1W", days: 7, words: "past week" },
  { label: "1M", days: 30, words: "past month" },
  { label: "3M", days: 90, words: "past 3 months" },
  { label: "6M", days: 182, words: "past 6 months" },
] as const;
type Range = (typeof RANGES)[number];

const UP = "#1d7a4f";
const DOWN = "var(--color-stop)";
const DAY = 86_400_000;

const inRange = (series: Point[], r: Range) => {
  if (!series.length) return series;
  const from = series[series.length - 1].t - r.days * DAY;
  return series.filter((p) => p.t >= from);
};

export function MarketsPage({
  messages,
  onSay,
  busy = false,
  onStop,
  spentToday,
  budget,
  remainingLabel,
}: {
  messages: ChatMessage[];
  onSay: (text: string, via?: InputVia) => void;
  busy?: boolean;
  onStop?: () => void;
  spentToday: number;
  budget: number;
  /** The backend's exact remaining figure, when logged in. */
  remainingLabel?: string;
}) {
  const { data, loading, updatedAt, refresh } = useMarketData();
  const [symbol, setSymbol] = useState("BTC");
  const [range, setRange] = useState<Range>(RANGES[1]);
  const [saved, setSaved] = useState<string[]>([]);
  const [drawer, setDrawer] = useState(false);
  const meta = WATCHLIST.find((a) => a.symbol === symbol) ?? WATCHLIST[0];
  const d = data[meta.symbol];
  const left = Math.max(0, budget - spentToday);

  const ask = (text: string) => {
    onSay(text);
    setDrawer(true);
  };
  const report = d?.related?.[0]?.question ?? `${meta.name}'s price outlook`;

  return (
    <div
      className="min-h-[calc(100vh-4rem)] text-ink"
      style={{
        background:
          "radial-gradient(60% 45% at 100% 0%, rgba(42,125,255,0.08), transparent 70%), radial-gradient(70% 50% at 0% 100%, rgba(39,117,202,0.10), transparent 70%), var(--color-paper)",
      }}
    >
      <div className={`mx-auto max-w-[1600px] px-4 pb-36 pt-6 transition-[padding] duration-300 sm:px-8 ${drawer ? "xl:pr-[452px]" : ""}`}>
        <Header
          meta={meta}
          left={remainingLabel ?? usd(left)}
          saved={saved.includes(meta.symbol)}
          onSave={() => setSaved((s) => (s.includes(meta.symbol) ? s.filter((x) => x !== meta.symbol) : [...s, meta.symbol]))}
          onAsk={() => ask(`What should I know about ${meta.name} right now?`)}
          onReport={() => ask(`Get me the full report on: ${report}`)}
        />
        <AssetView key={meta.symbol} meta={meta} d={d} spy={data.SPY} loading={loading} range={range} setRange={setRange} ask={ask} onRetry={refresh} />
        <Sources updatedAt={updatedAt} loading={loading} onRefresh={refresh} />
      </div>

      <Dock symbol={symbol} setSymbol={setSymbol} onMic={() => setDrawer(true)} saved={saved} data={data} />

      {/* Agent drawer: stays mounted so the conversation and voice keep their place. */}
      <div
        inert={!drawer}
        className={`fixed bottom-0 right-0 top-16 z-30 w-full max-w-[420px] p-4 transition-transform duration-300 ${
          drawer ? "translate-x-0" : "translate-x-[105%]"
        }`}
      >
        <div className="relative h-full shadow-[0_30px_80px_-30px_rgba(19,33,46,0.45)]">
          <VoicePanel messages={messages} onSay={onSay} busy={busy} onStop={onStop} />
          <button
            onClick={() => setDrawer(false)}
            aria-label="Close agent"
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full text-ink-soft hover:bg-paper hover:text-ink"
          >
            <X size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
const btn =
  "flex items-center gap-2 rounded-xl border border-line bg-surface px-3.5 py-2 text-[15px] font-medium text-ink hover:border-ink-soft";

function Header({
  meta,
  left,
  saved,
  onSave,
  onAsk,
  onReport,
}: {
  meta: AssetMeta;
  left: string;
  saved: boolean;
  onSave: () => void;
  onAsk: () => void;
  onReport: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-4">
        <Tile meta={meta} size="lg" />
        <div className="leading-tight">
          <h1 className="text-[20px] font-bold tracking-[-0.01em]">{meta.symbol}</h1>
          <div className="text-[16px] text-ink-soft">{meta.name}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 hidden items-center gap-2 text-sm text-ink-soft md:flex">
          <Wallet size={15} className="text-pine" /> {left} USDC left today
        </span>
        <button onClick={onAsk} className={btn}>
          <MessageCircle size={17} className="text-pine" /> Ask agent
        </button>
        <button onClick={onReport} className={btn}>
          <FileText size={17} className="text-pine" /> Full report
        </button>
        <button onClick={onSave} aria-pressed={saved} aria-label={saved ? "Remove from saved" : "Save"} className={`${btn} px-2.5`}>
          <Bookmark size={18} className="text-pine" fill={saved ? "currentColor" : "none"} />
        </button>
      </div>
    </div>
  );
}

function Tile({ meta, size = "sm", active = false }: { meta: AssetMeta; size?: "sm" | "lg"; active?: boolean }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center font-bold text-white ${
        size === "lg" ? "h-12 w-12 rounded-xl text-[13px]" : "h-9 w-9 rounded-[10px] text-[10px]"
      } ${active ? "ring-2 ring-pine ring-offset-2 ring-offset-surface" : ""}`}
      style={{ background: meta.color }}
    >
      {meta.symbol}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The asset: price + chart, key indicators card, stats strip, prediction markets
// ---------------------------------------------------------------------------
function AssetView({
  meta,
  d,
  spy,
  loading,
  range,
  setRange,
  ask,
  onRetry,
}: {
  meta: AssetMeta;
  d: AssetData | undefined;
  spy: AssetData | undefined;
  loading: boolean;
  range: Range;
  setRange: (r: Range) => void;
  ask: (t: string) => void;
  onRetry: () => void;
}) {
  const [tab, setTab] = useState<"Indicators" | "Odds" | "About">("Indicators");
  const q = d?.quote;
  const data = useMemo(() => (q ? inRange(q.series, range) : []), [q, range]);

  if (!q) {
    return (
      <div className="mt-10 flex min-h-[420px] flex-col items-center justify-center gap-3 rounded-[22px] border border-line bg-surface text-center">
        {d?.quoteError && !loading ? (
          <>
            <p className="text-[17px] font-semibold">Couldn't load live prices for {meta.symbol}</p>
            <p className="max-w-[44ch] text-[15px] text-ink-soft">The price service didn't respond ({d.quoteError}). Check your connection and try again.</p>
            <button onClick={onRetry} className={`${btn} mt-2`}>
              <RefreshCw size={16} className="text-pine" /> Try again
            </button>
          </>
        ) : (
          <>
            <RefreshCw size={22} className="animate-spin text-pine" />
            <p className="text-[15px] text-ink-soft">Loading live prices for {meta.symbol}…</p>
          </>
        )}
      </div>
    );
  }

  const first = data[0]?.price ?? q.price;
  const change = q.price - first;
  const pct = pctChange(first, q.price);
  const up = change >= 0;
  const prices = data.map((p) => p.price).concat(q.price);
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const returns = data.slice(1).map((p, i) => p.price / data[i].price - 1);
  const mean = returns.reduce((s, r) => s + r, 0) / Math.max(1, returns.length);
  const volatility = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, returns.length)) * 100;
  const related = d?.related ?? [];
  const top = related[0]; // most-traded open market (marketsApi sorts by volume)
  const [dollars, cents] = q.price.toFixed(2).split(".");

  // Versus the S&P 500 over the same window (if SPY loaded).
  const spyQ = spy?.quote;
  let vs: { good: boolean; text: React.ReactNode } | null = null;
  if (meta.symbol === "SPY") {
    vs = { good: up, text: <>The S&P 500 is {up ? "up" : "down"} <b>{Math.abs(pct).toFixed(2)}%</b> {range.words}</> };
  } else if (spyQ) {
    const s = inRange(spyQ.series, range);
    const spyPct = s.length ? pctChange(s[0].price, spyQ.price) : 0;
    const diff = pct - spyPct;
    vs = {
      good: diff >= 0,
      text: (
        <>
          {diff >= 0 ? "Outperforming" : "Underperforming"} the S&P 500 by <b>{Math.abs(diff).toFixed(2)}%</b> {range.words}
        </>
      ),
    };
  }
  const offHigh = ((high - q.price) / high) * 100;

  return (
    <>
      <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
        {/* Price + chart */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="text-[40px] font-bold tracking-[-0.02em]">
                ${Number(dollars).toLocaleString("en-US")}
                <span className="text-muted">.{cents}</span>
              </span>
              <span className="text-[17px] font-semibold" style={{ color: up ? UP : DOWN }}>
                {up ? "+" : "−"}
                {formatPrice(Math.abs(change))} ({up ? "+" : "−"}
                {Math.abs(pct).toFixed(2)}%)
              </span>
              <span className="text-[17px] text-ink-soft">{range.words}</span>
            </div>
            <span className="flex items-center gap-2 text-sm">
              <span className="font-semibold" style={{ color: q.dayChangePct >= 0 ? UP : DOWN }}>
                {q.dayChangePct >= 0 ? "+" : "−"}
                {Math.abs(q.dayChangePct).toFixed(2)}% {meta.kind === "Crypto" ? "24h" : "today"}
              </span>
              <span className="rounded-md border border-line bg-surface px-2 py-0.5 text-xs text-ink-soft">USD · {meta.exchange}</span>
            </span>
          </div>

          <PriceChart data={data} up={up} />

          <div className="mt-4 flex flex-wrap gap-1" role="tablist" aria-label="Chart range">
            {RANGES.map((r) => (
              <button
                key={r.label}
                role="tab"
                aria-selected={r.label === range.label}
                onClick={() => setRange(r)}
                className={`rounded-lg px-3.5 py-1.5 text-[15px] font-semibold ${
                  r.label === range.label ? "bg-surface text-ink shadow-[inset_0_0_0_1px_var(--color-line)]" : "text-ink-soft hover:text-ink"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {/* Key indicators card (with a stacked-card edge behind it) */}
        <div>
          <div className="relative">
            <div className="absolute -right-2 bottom-3 top-3 w-full rounded-[22px] border border-line bg-paper" aria-hidden="true" />
            <div className="relative flex min-h-[420px] flex-col rounded-[22px] border border-line bg-surface p-8">
              <div className="flex items-center justify-between">
                <h2 className="text-[17px] font-semibold">
                  {tab === "Indicators" ? "Key indicators" : tab === "Odds" ? "Prediction market odds" : `About ${meta.name}`}
                </h2>
                <Maximize2 size={16} className="text-muted" aria-hidden="true" />
              </div>

              <div className="flex flex-1 flex-col justify-center py-6">
                {tab === "Indicators" && (
                  <ul className="space-y-4">
                    {vs && <Indicator good={vs.good} text={vs.text} />}
                    <Indicator
                      good={offHigh < 1}
                      text={offHigh < 1 ? <>Trading near its {range.words} high</> : <>Trading <b>{offHigh.toFixed(2)}%</b> below its {range.words} high</>}
                    />
                    {top ? (
                      <Indicator
                        good={top.yesPrice >= 0.5}
                        text={
                          <>
                            Polymarket gives <b>{Math.round(top.yesPrice * 100)}%</b> odds: {top.question.replace(/\?$/, "")}
                          </>
                        }
                      />
                    ) : (
                      <li className="text-[15px] text-ink-soft">No open prediction markets found for {meta.name}.</li>
                    )}
                  </ul>
                )}
                {tab === "Odds" &&
                  (related.length ? (
                    <ul className="space-y-5">
                      {related.map((m) => (
                        <li key={m.question}>
                          <div className="flex items-baseline justify-between gap-4">
                            <span className="text-[15px]">{m.question}</span>
                            <span className="text-[18px] font-bold text-pine">{Math.round(m.yesPrice * 100)}%</span>
                          </div>
                          <div className="mt-2 h-1.5 rounded-full bg-paper">
                            <div className="h-full rounded-full bg-pine" style={{ width: `${m.yesPrice * 100}%` }} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[15px] text-ink-soft">No open prediction markets found for {meta.name}.</p>
                  ))}
                {tab === "About" && (
                  <div>
                    <p className="text-[16px] leading-relaxed text-ink-soft">{meta.about}</p>
                    <dl className="mt-6 grid grid-cols-3 gap-4 text-sm">
                      {[
                        ["Type", meta.kind],
                        ["Exchange", meta.exchange],
                        meta.kind === "Crypto" ? ["Market cap", q.marketCap ? `$${compact(q.marketCap)}` : "—"] : ["52-wk range", q.low52 && q.high52 ? `${formatPrice(q.low52)}–${formatPrice(q.high52)}` : "—"],
                      ].map(([k, v]) => (
                        <div key={k}>
                          <dt className="text-muted">{k}</dt>
                          <dd className="mt-0.5 font-semibold">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )}
              </div>

              <p className="text-sm text-muted">Live public odds from Polymarket (free, not paid through Allowance).</p>
            </div>
          </div>

          <div className="mt-4 flex gap-1" role="tablist" aria-label="Card view">
            {(["Indicators", "Odds", "About"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-lg px-3.5 py-1.5 text-[15px] font-semibold ${
                  tab === t ? "bg-surface text-ink shadow-[inset_0_0_0_1px_var(--color-line)]" : "text-ink-soft hover:text-ink"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Stats strip */}
      <dl className="mt-14 grid grid-cols-2 gap-y-6 rounded-[22px] border border-line bg-surface py-7 sm:grid-cols-4 lg:grid-cols-8 lg:divide-x lg:divide-line">
        {[
          meta.kind === "Crypto" ? ["Mkt cap", q.marketCap ? `$${compact(q.marketCap)}` : "—"] : ["Prev close", q.prevClose ? formatPrice(q.prevClose) : "—"],
          [meta.kind === "Crypto" ? "24h volume" : "Volume", meta.kind === "Crypto" ? `$${compact(q.volume)}` : compact(q.volume)],
          [`${range.label} high`, formatPrice(high)],
          [`${range.label} low`, formatPrice(low)],
          [`${range.label} change`, `${up ? "+" : "−"}${Math.abs(pct).toFixed(2)}%`, up ? UP : DOWN],
          ["Volatility", `${volatility.toFixed(2)}%`],
          ["Top odds", top ? `${Math.round(top.yesPrice * 100)}%` : "—"],
          ["Exchange", meta.exchange],
        ].map(([k, v, color]) => (
          <div key={k} className="px-4 text-center">
            <dt className="text-[13px] text-muted">{k}</dt>
            <dd className="mt-1.5 text-[19px] font-bold" style={color ? { color } : undefined}>
              {v}
            </dd>
          </div>
        ))}
      </dl>

      {/* Prediction markets */}
      <section className="mt-6 rounded-[22px] border border-line bg-surface p-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[20px] font-bold tracking-[-0.01em]">Prediction markets on {meta.symbol}</h2>
          <button onClick={() => ask(`What are prediction markets saying about ${meta.name}?`)} className={btn}>
            <MessageCircle size={17} className="text-pine" /> Ask about {meta.symbol}
          </button>
        </div>
        {related.length ? (
          <ul className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {related.map((m) => (
              <li key={m.question} className="flex flex-col rounded-2xl border border-line bg-paper/50 p-5">
                <div className="flex items-start justify-between gap-4">
                  <p className="text-[16px] font-medium leading-snug">{m.question}</p>
                  <span className="shrink-0 text-right">
                    <span className="block text-[26px] font-bold leading-none text-pine">{Math.round(m.yesPrice * 100)}%</span>
                    <span className="text-xs text-ink-soft">chance yes</span>
                  </span>
                </div>
                <div className="mt-4 h-1.5 rounded-full bg-line/60">
                  <div className="h-full rounded-full bg-pine" style={{ width: `${m.yesPrice * 100}%` }} />
                </div>
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => ask(m.question)}
                    className="flex items-center gap-1.5 rounded-lg bg-pine px-3.5 py-2 text-sm font-semibold text-white hover:bg-[#163f75]"
                  >
                    <MessageCircle size={15} /> Quick answer
                  </button>
                  <button onClick={() => ask(`Get me the full report on: ${m.question}`)} className={`${btn} text-sm`}>
                    <FileText size={15} className="text-pine" /> Full report
                  </button>
                  <a href={m.url} target="_blank" rel="noreferrer" className="ml-auto flex items-center gap-1 text-sm font-medium text-usdc hover:underline">
                    Polymarket <ExternalLink size={13} />
                  </a>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-6 text-[15px] text-ink-soft">
            {d?.relatedError ? `Couldn't load prediction markets (${d.relatedError}).` : `No open prediction markets found for ${meta.name}.`}
          </p>
        )}
      </section>
    </>
  );
}

function Indicator({ good, text }: { good: boolean; text: React.ReactNode }) {
  const Icon = good ? TrendingUp : TrendingDown;
  return (
    <li className="flex items-start gap-3 text-[16px] leading-snug text-ink-soft [&_b]:font-semibold [&_b]:text-ink">
      <span
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border"
        style={{ color: good ? UP : DOWN, borderColor: good ? UP : DOWN }}
      >
        <Icon size={11} strokeWidth={2.5} />
      </span>
      <span>{text}</span>
    </li>
  );
}

function Sources({ updatedAt, loading, onRefresh }: { updatedAt: number | null; loading: boolean; onRefresh: () => void }) {
  return (
    <p className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
      <span>
        Free public data, not bought through Allowance: prices from CoinGecko (crypto) and Yahoo Finance (stocks), odds from Polymarket. Paid
        Gemini market data comes only through the assistant.
      </span>
      <span>{updatedAt ? `Updated ${new Date(updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : "Loading…"}</span>
      <button onClick={onRefresh} disabled={loading} className="flex items-center gap-1 font-medium text-pine hover:underline disabled:opacity-50">
        <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
      </button>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Chart: brand-blue line over a dotted field, volume bars underneath.
// ---------------------------------------------------------------------------
function PriceChart({ data, up }: { data: Point[]; up: boolean }) {
  const W = 1000;
  const H = 360;
  const [hover, setHover] = useState<number | null>(null);
  if (data.length < 2) return <div className="mt-6 h-[300px] sm:h-[360px]" />;
  const min = Math.min(...data.map((p) => p.price));
  const max = Math.max(...data.map((p) => p.price));
  const span = max - min || 1;
  const pts = data.map((p, i) => [(i / (data.length - 1)) * W, 20 + (1 - (p.price - min) / span) * (H - 40)] as const);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const last = pts[pts.length - 1];
  const h = hover !== null ? pts[hover] : null;
  const maxVol = Math.max(...data.map((p) => p.volume)) || 1;

  return (
    <div
      className="relative mt-6 touch-none select-none"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const i = Math.round(((e.clientX - r.left) / r.width) * (data.length - 1));
        setHover(Math.min(data.length - 1, Math.max(0, i)));
      }}
      onPointerLeave={() => setHover(null)}
    >
      <div
        className="relative h-[300px] sm:h-[360px]"
        style={{
          backgroundImage: "radial-gradient(rgba(19,33,46,0.10) 1px, transparent 1.3px)",
          backgroundSize: "14px 14px",
          maskImage: "linear-gradient(to right, rgba(0,0,0,0.3), #000 35%)",
        }}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" role="img" aria-label="Price chart">
          <defs>
            <linearGradient id="mk-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="var(--color-pine)" stopOpacity="0.14" />
              <stop offset="1" stopColor="var(--color-pine)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#mk-fill)" />
          <path d={line} fill="none" stroke="var(--color-pine)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {h && <line x1={h[0]} x2={h[0]} y1="0" y2={H} stroke="rgba(19,33,46,0.3)" vectorEffect="non-scaling-stroke" />}
        </svg>
      {/* Dots and tooltip are positioned against the chart box only (not the volume bars). */}
      <span
        className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ left: `${(last[0] / W) * 100}%`, top: `${(last[1] / H) * 100}%`, background: up ? UP : DOWN, boxShadow: `0 0 0 5px ${up ? "rgba(29,122,79,0.18)" : "rgba(179,65,47,0.18)"}`, opacity: h ? 0 : 1 }}
      />
      {h && hover !== null && (
        <>
          <span
            className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-pine"
            style={{ left: `${(h[0] / W) * 100}%`, top: `${(h[1] / H) * 100}%` }}
          />
          <span
            className="pointer-events-none absolute -top-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-xs font-semibold text-white"
            style={{ left: `${Math.min(92, Math.max(8, (h[0] / W) * 100))}%` }}
          >
            ${formatPrice(data[hover].price)} · {new Date(data[hover].t).toLocaleDateString([], { month: "short", day: "numeric" })}
          </span>
        </>
      )}
      </div>
      <svg viewBox={`0 0 ${W} 56`} preserveAspectRatio="none" className="h-[48px] w-full" aria-hidden="true">
        {data.map((p, i) => {
          const bw = W / data.length;
          const v = p.volume / maxVol;
          return <rect key={i} x={i * bw + bw * 0.2} width={bw * 0.6} y={56 - v * 56} height={v * 56} fill={hover === i ? "var(--color-pine)" : "rgba(29,79,145,0.18)"} />;
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dock: switch assets, open the agent, search.
// ---------------------------------------------------------------------------
function Dock({
  symbol,
  setSymbol,
  onMic,
  saved,
  data,
}: {
  symbol: string;
  setSymbol: (s: string) => void;
  onMic: () => void;
  saved: string[];
  data: Record<string, AssetData>;
}) {
  const [search, setSearch] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (search) inputRef.current?.focus();
  }, [search]);
  const results = WATCHLIST.filter((a) => `${a.symbol} ${a.name}`.toLowerCase().includes(q.toLowerCase()));
  const shell = "border border-line bg-surface/90 shadow-[0_20px_50px_-20px_rgba(19,33,46,0.35)] backdrop-blur-md";

  return (
    <div className="fixed bottom-6 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3">
      <div className={`flex items-center gap-1.5 rounded-full px-3 py-2.5 ${shell}`}>
        {WATCHLIST.map((a) => (
          <button
            key={a.symbol}
            onClick={() => setSymbol(a.symbol)}
            aria-label={`${a.name}${saved.includes(a.symbol) ? ", saved" : ""}`}
            aria-current={a.symbol === symbol ? "true" : undefined}
            className={`relative rounded-[10px] transition-opacity ${a.symbol === symbol ? "" : "opacity-60 hover:opacity-100"}`}
          >
            <Tile meta={a} active={a.symbol === symbol} />
            {saved.includes(a.symbol) && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-pine ring-2 ring-surface" />}
          </button>
        ))}
        <span className="mx-1.5 h-6 w-px bg-line" aria-hidden="true" />
        <button onClick={onMic} aria-label="Talk to the agent" className="flex h-9 w-9 items-center justify-center rounded-full bg-pine text-white hover:bg-[#163f75]">
          <Mic size={17} />
        </button>
      </div>

      <div className="relative">
        <button
          onClick={() => setSearch((s) => !s)}
          aria-label="Search stocks and crypto"
          aria-expanded={search}
          className={`flex h-[56px] w-[56px] items-center justify-center rounded-full text-ink-soft hover:text-ink ${shell}`}
        >
          {search ? <X size={20} /> : <Search size={20} />}
        </button>
        {search && (
          <div className={`absolute bottom-full right-0 mb-3 w-[300px] rounded-2xl p-2 ${shell}`}>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearch(false);
                if (e.key === "Enter" && results[0]) {
                  setSymbol(results[0].symbol);
                  setSearch(false);
                }
              }}
              placeholder="Search stocks and crypto"
              aria-label="Search stocks and crypto"
              className="w-full rounded-xl border border-line bg-paper px-3 py-2.5 text-sm outline-none placeholder:text-muted focus:border-ink-soft"
            />
            <ul className="mt-1 max-h-[260px] overflow-y-auto">
              {results.length === 0 && <li className="px-3 py-3 text-sm text-ink-soft">Nothing matches "{q}".</li>}
              {results.map((a) => {
                const price = data[a.symbol]?.quote?.price;
                return (
                  <li key={a.symbol}>
                    <button
                      onClick={() => {
                        setSymbol(a.symbol);
                        setSearch(false);
                        setQ("");
                      }}
                      className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-paper"
                    >
                      <Tile meta={a} />
                      <span className="flex-1">
                        <span className="block text-sm font-semibold">{a.symbol}</span>
                        <span className="block text-xs text-ink-soft">{a.name}</span>
                      </span>
                      <span className="text-sm text-ink-soft">{price ? formatPrice(price) : "…"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
