// IntroHero: the landing page's opening. Plays once on page load (no scrolling needed):
//
//   0–20%   logo large and centered, then zooms out to a small mark
//   20–90%  the mascot rides the wavy line left to right, drawing it as it goes
//   90–100% headline, subtext and buttons settle in
//
// Timing lives in CSS variables on `.hs` in src/index.css: --hs-intro is the total length,
// and each phase's start/end is a fraction of it. This file reads them from there.
// A requestAnimationFrame loop advances `progress` (0..1) over --hs-intro, writes it to
// --progress for the CSS pieces, and passes the mascot's share of it to ScanPath.
// "Skip intro" jumps to the end; reduced motion starts at the end.
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Mic } from "lucide-react";
import type { Payment } from "../types";
import { Mark } from "./Mark";
import { ScanPath } from "./ScanPath";

// Gentle ease-in-out for the mascot's ride, so it starts and stops softly.
const ease = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

export function IntroHero({ onTry, onHow, latest }: { onTry: () => void; onHow: () => void; latest: Payment | undefined }) {
  const ref = useRef<HTMLElement>(null);
  const [progress, setProgress] = useState(0);
  const [phases, setPhases] = useState({ pathA: 0.2, pathB: 0.9, ctaA: 0.94 });
  const rafRef = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const num = (name: string, fallback: number) => parseFloat(cs.getPropertyValue(name)) || fallback;
    setPhases({ pathA: num("--hs-path-a", 0.2), pathB: num("--hs-path-b", 0.9), ctaA: num("--hs-cta-a", 0.94) });
    const total = num("--hs-intro", 8) * 1000; // ms

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setProgress(1);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / total);
      setProgress(p);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const skip = () => {
    cancelAnimationFrame(rafRef.current);
    setProgress(1);
  };

  const travel = ease(Math.min(1, Math.max(0, (progress - phases.pathA) / (phases.pathB - phases.pathA))));
  const live = progress >= phases.ctaA;

  return (
    <section
      ref={ref}
      id="top"
      className="hs relative"
      data-live={live || undefined}
      style={{ "--progress": progress.toFixed(4) } as React.CSSProperties}
    >
      <div className="hs-stage relative flex flex-col overflow-hidden">
        {/* Logo: big and centered, then zooms out to a small mark above the headline */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
          <div className="hs-logo" data-anim>
            <Mark className="hs-logo-mark" />
          </div>
        </div>

        {/* Room for the small logo mark */}
        <div className="hs-logo-space shrink-0" aria-hidden="true" />

        {/* Real hero content: in the DOM from the start, settles in at the end */}
        <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-4 text-center">
          <h1
            className="hs-head font-display bg-clip-text pb-2 text-[clamp(38px,min(6vw,9svh),96px)] font-extrabold leading-[0.94] tracking-[-0.04em] text-transparent"
            data-anim
            style={{ backgroundImage: "linear-gradient(95deg, #1247d6 0%, #2a7dff 50%, #1fb0f0 100%)" }}
          >
            Your agent pays.{" "}
            <br className="hidden sm:block" />
            You set the limits.
          </h1>
          <p className="hs-sub font-display mt-3 text-[clamp(17px,1.6vw,24px)] font-semibold tracking-[-0.015em] text-[#4f6f9c]" data-anim>
            Give your AI agent an allowance, not your wallet.
          </p>
          <div className="hs-cta mt-5 flex flex-wrap items-center justify-center gap-2" data-anim>
            <button
              onClick={onTry}
              className="flex items-center gap-2 rounded-full bg-pine px-5 py-3 text-[15px] font-semibold text-white hover:bg-[#163f75]"
            >
              <Mic size={16} /> See the demo
            </button>
            <button onClick={onHow} className="flex items-center gap-1.5 rounded-full px-4 py-3 text-[15px] font-medium text-ink-soft hover:text-ink">
              How it works <ArrowRight size={16} />
            </button>
          </div>
        </div>

        {/* The mascot riding the spending line */}
        <div className="hs-path relative shrink-0">
          <ScanPath progress={travel} latest={latest} />
        </div>

        {/* Skip, while the intro is playing */}
        {progress < 1 && (
          <button
            onClick={skip}
            className="absolute right-4 top-[calc(var(--nav-height)+12px)] rounded-full border border-line bg-surface/70 px-4 py-2 text-[13px] font-medium text-ink-soft backdrop-blur-sm hover:text-ink sm:right-8"
          >
            Skip intro
          </button>
        )}
      </div>
    </section>
  );
}
