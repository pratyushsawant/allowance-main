// ScanPath: the agent mascot riding the wavy spending line. `progress` (0..1) comes from
// the hero's scroll position: 0 = left end of the path, 1 = right end.
//
// The wave is an SVG stretched to fill its box. The mascot and its speech bubble sit on
// top as fixed-size overlays, placed with getPointAtLength() on that same path so they stay
// exactly on the curve at any screen size. Everything that moves uses transform, opacity or
// stroke-dashoffset only.
import { useLayoutEffect, useRef, useState } from "react";
import { Check, Hand } from "lucide-react";
import type { Payment } from "../types";
import { MascotArt } from "./Mascot";

const W = 1600;
const H = 250;
const PATH =
  "M0,170 C110,160 190,186 290,180 S450,128 560,140 S720,196 830,184 S990,112 1090,122 S1250,186 1350,172 S1500,108 1600,112";
const MAX_TILT = 10; // degrees
const MARGIN = 44; // px kept between the mascot and the screen edge at both ends

type Stop = { at: number; tone: "pay" | "hold"; label: string }; // `at` = fraction of the path

type Geo = {
  path: SVGPathElement;
  len: number;
  w: number; // box size in px
  h: number;
  t0: number; // travel range along the path, trimmed so the mascot stays on screen
  t1: number;
};

export function ScanPath({ progress, latest }: { progress: number; latest: Payment | undefined }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [bubbleW, setBubbleW] = useState(180);

  // The latest real payment when there is one; otherwise the snapshot's catalog price.
  const first = latest?.status === "confirmed" ? (latest.amountLabel ?? latest.amount.toString()) : "0.005";
  const stops: Stop[] = [
    { at: 0.22, tone: "pay", label: `−${first} USDC` },
    { at: 0.47, tone: "pay", label: "−0.02 USDC" },
    { at: 0.73, tone: "hold", label: "0.75 USDC needs your OK" },
  ];

  // Measure the path and box; redo on resize so it scales with the viewport.
  useLayoutEffect(() => {
    const box = boxRef.current;
    const path = pathRef.current;
    if (!box || !path) return;
    const measure = () => {
      const len = path.getTotalLength();
      const w = box.clientWidth;
      const h = box.clientHeight;
      const xAt = (t: number) => (path.getPointAtLength(t * len).x / W) * w;
      let t0 = 0;
      let t1 = 1;
      for (let i = 0; i <= 400; i++) if (xAt(i / 400) >= MARGIN) { t0 = i / 400; break; }
      for (let i = 400; i >= 0; i--) if (xAt(i / 400) <= w - MARGIN) { t1 = i / 400; break; }
      setGeo({ path, len, w, h, t0, t1 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  const t = geo ? geo.t0 + Math.min(1, Math.max(0, progress)) * (geo.t1 - geo.t0) : 0;

  const say =
    progress < 0.25
      ? "Scanning BTC odds…"
      : progress < 0.5
        ? `Paid ${first} USDC on Arc`
        : progress < 0.75
          ? "Checking the Fed market…"
          : progress < 0.98
            ? "Over your limit. Asking you first."
            : "Waiting for your OK.";

  useLayoutEffect(() => {
    if (bubbleRef.current) setBubbleW(bubbleRef.current.offsetWidth);
  }, [say, geo?.w]);

  // Where the mascot is, in px inside the box, and the slope of the line there.
  let x = 0;
  let y = 0;
  let tilt = 0;
  if (geo) {
    const sx = geo.w / W;
    const sy = geo.h / H;
    const d = t * geo.len;
    const p = geo.path.getPointAtLength(d);
    const a = geo.path.getPointAtLength(Math.max(0, d - 4));
    const b = geo.path.getPointAtLength(Math.min(geo.len, d + 4));
    x = p.x * sx;
    y = p.y * sy;
    const deg = (Math.atan2((b.y - a.y) * sy, (b.x - a.x) * sx) * 180) / Math.PI;
    tilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, deg));
  }
  const mascotW = geo && geo.w < 640 ? 54 : 72;
  const mascotH = (mascotW * 104) / 84;
  const bubbleX = geo ? Math.min(geo.w - bubbleW / 2 - 8, Math.max(bubbleW / 2 + 8, x)) : 0;
  const pointAt = (at: number) => (geo ? geo.path.getPointAtLength(at * geo.len) : { x: 0, y: 0 });

  return (
    <div ref={boxRef} className="relative h-full w-full" aria-hidden="true">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          <linearGradient id="scan-line" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#1247d6" />
            <stop offset="1" stopColor="#1fb0f0" />
          </linearGradient>
        </defs>
        {/* The road ahead, not yet analyzed */}
        <path d={PATH} fill="none" stroke="rgba(19,33,46,0.22)" strokeWidth="2" strokeDasharray="2 9" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {/* What the agent has analyzed so far: drawn up to the mascot */}
        <path
          ref={pathRef}
          d={PATH}
          fill="none"
          stroke="url(#scan-line)"
          strokeWidth="3"
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray="1 1"
          strokeDashoffset={progress >= 1 ? 0 : 1 - t} /* once the mascot arrives, finish the line to the edge */
          vectorEffect="non-scaling-stroke"
          style={{ filter: "drop-shadow(0 0 8px rgba(42,125,255,0.45))" }}
        />
      </svg>

      {/* Payment markers drop in as the mascot passes them (and go again on the way back) */}
      {geo &&
        stops.map((s) => {
          const p = pointAt(s.at);
          const on = t >= s.at;
          const color = s.tone === "hold" ? "#c98a12" : "#1d4f91";
          return (
            <span key={s.at} className="absolute left-0 top-0" style={{ transform: `translate(${(p.x / W) * geo.w}px, ${(p.y / H) * geo.h}px)` }}>
              <span
                className="absolute -left-[7px] -top-[7px] h-[14px] w-[14px] rounded-full border-2 border-surface transition-[opacity,transform] duration-200"
                style={{ background: color, opacity: on ? 1 : 0, transform: on ? "scale(1)" : "scale(0.4)", boxShadow: `0 0 0 5px ${color}2e` }}
              />
              <span
                className={`absolute left-0 top-4 hidden -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-[12px] font-semibold transition-opacity duration-200 sm:flex ${
                  s.tone === "hold" ? "border-hold/40 bg-hold-soft text-[#8a5d08]" : "border-line bg-surface text-pine"
                }`}
                style={{ opacity: on ? 1 : 0 }}
              >
                {s.tone === "hold" ? <Hand size={12} /> : <Check size={12} strokeWidth={3} />}
                {s.label}
              </span>
            </span>
          );
        })}

      {/* The mascot with its scanning cone, riding the line */}
      {geo && (
        <div
          className="absolute left-0 top-0"
          style={{
            width: mascotW,
            height: mascotH,
            transformOrigin: "50% 100%",
            transform: `translate(${x - mascotW / 2}px, ${y - mascotH}px) rotate(${tilt}deg)`,
          }}
        >
          <svg viewBox="-12 0 84 104" className="h-full w-full overflow-visible">
            <defs>
              <linearGradient id="scan-beam" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#2a7dff" stopOpacity="0.38" />
                <stop offset="1" stopColor="#2a7dff" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d="M22,58 L-10,104 L70,104 L38,58 Z" fill="url(#scan-beam)" />
            <g className="bob">
              <MascotArt />
            </g>
          </svg>
        </div>
      )}

      {/* What the agent is doing right now, kept above the mascot and inside the screen */}
      {geo && (
        <span
          ref={bubbleRef}
          className="absolute left-0 top-0 max-w-[220px] whitespace-nowrap rounded-xl bg-ink px-3 py-1.5 text-[12px] font-medium text-white shadow-lg sm:text-[13px]"
          style={{ transform: `translate(${bubbleX - bubbleW / 2}px, ${y - mascotH - 40}px)` }}
        >
          {say}
        </span>
      )}
    </div>
  );
}
