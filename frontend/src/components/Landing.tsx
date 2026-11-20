// The home page: announcement, nav, hero, how it works, the rules, footer.
import { useEffect, useState } from "react";
import {
  LineChart,
  Mic,
  ShieldCheck,
  X,
} from "lucide-react";
import type { Payment, Rules } from "../types";
import { USE_MOCK } from "../config";
import { RulesFlow } from "../landing/RulesFlow";
import { Mark } from "../landing/Mark";
import { IntroHero } from "../landing/IntroHero";

const SECTIONS = [
  { id: "how-it-works", label: "How it works" },
  { id: "rules", label: "Rules" },
];

export function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------------------------------------------------------------------------
// Nav: transparent over the home hero, solid everywhere else.
// ---------------------------------------------------------------------------
export type Page = "home" | "markets" | "demo";

export function Nav({ page, go }: { page: Page; go: (page: Page, section?: string) => void }) {
  const [active, setActive] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [pastHero, setPastHero] = useState(false);

  useEffect(() => {
    setActive(null);
    const onScroll = () => {
      setScrolled(window.scrollY > 8);
      setPastHero(window.scrollY > window.innerHeight - 96);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    if (page !== "home") return () => window.removeEventListener("scroll", onScroll);

    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => e.isIntersecting && setActive(e.target.id)),
      { rootMargin: "-45% 0px -50% 0px" },
    );
    [...SECTIONS.map((s) => s.id), "top"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    });
    return () => {
      window.removeEventListener("scroll", onScroll);
      io.disconnect();
    };
  }, [page]);

  // Transparent only while the page is at the very top; solid as soon as content scrolls under it.
  const overlay = page === "home" && !pastHero && !scrolled;
  const link = (on: boolean) =>
    overlay
      ? "text-ink-soft hover:text-ink"
      : on
        ? "bg-surface text-ink shadow-[inset_0_0_0_1px_var(--color-line)]"
        : "text-ink-soft hover:text-ink";

  return (
    <nav
      className={`sticky top-0 z-40 h-[var(--nav-height)] border-b transition-colors duration-300 ${
        overlay
          ? "border-transparent bg-transparent"
          : `bg-paper/85 backdrop-blur-md ${scrolled ? "border-line" : "border-transparent"}`
      }`}
    >
      <div className="mx-auto flex h-full max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-8">
        <button onClick={() => go("home", "top")} className="flex items-center gap-2.5 text-[22px] font-bold tracking-[-0.02em]">
          <Mark />
          Allowance
        </button>
        <div className="flex items-center gap-1 sm:gap-2">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => go("home", s.id)}
              aria-current={page === "home" && active === s.id ? "true" : undefined}
              className={`hidden rounded-full px-3 py-2 text-sm font-medium transition-colors md:block ${link(page === "home" && active === s.id)}`}
            >
              {s.label}
            </button>
          ))}
          <button
            onClick={() => go("markets")}
            aria-current={page === "markets" ? "page" : undefined}
            aria-label="Markets"
            className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium transition-colors ${link(page === "markets")}`}
          >
            <LineChart size={15} /> <span className="hidden sm:inline">Markets</span>
          </button>
          <button
            onClick={() => go("demo")}
            aria-current={page === "demo" ? "page" : undefined}
            className={`ml-1 flex items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
              page === "demo" ? "bg-ink text-white" : "bg-pine text-white hover:bg-[#163f75]"
            }`}
          >
            <Mic size={15} /> Live demo
          </button>
          <span
            className={`ml-2 hidden items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium md:flex ${
              overlay
                ? "border-line bg-surface/70 text-ink-soft"
                : "border-line bg-surface text-ink-soft"
            }`}
          >
            <span className="relative flex h-2 w-2">
              <span className={`ring absolute inset-0 rounded-full bg-usdc`} />
              <span className={`relative h-2 w-2 rounded-full bg-usdc`} />
            </span>
            Arc Testnet
          </span>
        </div>
      </div>
    </nav>
  );
}

// The logo lives in src/landing/Mark.tsx; re-exported here for existing imports.
export { Mark };

// ---------------------------------------------------------------------------
// Announcement bar (above the nav on the home page)
// ---------------------------------------------------------------------------
export function Announcement({ onOpen }: { onOpen: () => void }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div className="relative z-50 flex h-9 items-center justify-center bg-pine px-10 text-[13px] text-white/85">
      <span className="truncate">
        New: ask your agent about stocks and crypto on the Markets page.{" "}
        <button onClick={onOpen} className="font-medium text-white underline underline-offset-2 hover:text-white/80">
          Take a look
        </button>
      </span>
      <button onClick={() => setOpen(false)} aria-label="Dismiss announcement" className="absolute right-3 rounded p-1 text-white/50 hover:text-white">
        <X size={14} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hero: the intro that plays on load (logo, mascot, rules, then the headline),
// followed by the mascot's spending-line scan and the "Built with" strip.
// ---------------------------------------------------------------------------
// Hero: the intro that plays on load (logo, then the mascot riding the spending
// line, then the headline), followed by the "Built with" strip.
// ---------------------------------------------------------------------------
export function Hero({ onTry, latest }: { onTry: (text: string) => void; latest: Payment | undefined }) {
  return (
    <>
      <IntroHero
        onTry={() => onTry("What are the odds BTC closes above 100k?")}
        onHow={() => scrollToId("how-it-works")}
        latest={latest}
      />
      <section className="relative bg-paper text-ink" aria-label="Built with">
        <div className="relative mx-auto w-full max-w-[1600px] px-4 sm:px-8">
          <BuiltWith />
        </div>
      </section>
    </>
  );
}
// What the project runs on. Plain names, not logos.
function BuiltWith() {
  return (
    <div className="relative flex flex-wrap items-center justify-between gap-x-10 gap-y-3 border-t border-line py-7 text-[17px] font-semibold tracking-[-0.01em] text-ink/40">
      <span className="text-[13px] font-medium text-muted">Built with</span>
      {["Arc", "USDC", "Gemini", "ElevenLabs", "QuickNode Streams"].map((n) => (
        <span key={n}>{n}</span>
      ))}
    </div>
  );
}


// ---------------------------------------------------------------------------
// The four rules: copy on the left, the live rules check (RulesFlow) on the right.
// ---------------------------------------------------------------------------
export function RulesExplainer({
  rules,
  spentToday,
  onOpenDemo,
}: {
  rules: Rules | null;
  spentToday: number;
  onOpenDemo: () => void;
}) {
  return (
    <section id="rules" className="scroll-mt-16">
      <div className="mx-auto grid max-w-[1600px] gap-12 px-4 py-24 sm:px-8 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <h2 className="max-w-[16ch] text-[36px] font-bold leading-[1.08] tracking-[-0.03em] sm:text-[44px]">
            Four rules your agent can't break
          </h2>
          <p className="mt-5 max-w-[42ch] text-[17px] leading-relaxed text-ink-soft">
            Every purchase is checked against these on the backend before any money moves. The values on the right are the live rules once you connect.
          </p>
          <button
            onClick={onOpenDemo}
            className="mt-7 flex items-center gap-2 rounded-full border border-line bg-surface px-5 py-3 text-[15px] font-semibold hover:border-ink-soft"
          >
            <ShieldCheck size={17} className="text-pine" /> See them in the demo
          </button>
        </div>

        {rules ? (
          <RulesFlow
            sellers={rules.allowlist}
            perRequestCap={rules.perRequestCap}
            dailyBudget={rules.dailyBudget}
            approvalThreshold={rules.approvalThreshold}
            spentToday={spentToday}
          />
        ) : (
          <div className="rounded-[22px] border border-line bg-surface p-7 text-[15px] text-ink-soft">
            The live rules load after you connect: open the demo and enter the access code. Defaults on the backend: pay only allowlisted sellers,
            at most 1.00 USDC per request and 3.00 USDC a day, and ask a person before anything over 0.25 USDC.
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------
export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4 px-4 py-8 text-sm text-ink-soft sm:px-8">
        <span className="flex items-center gap-2 font-semibold text-ink">
          <Mark size={20} /> Allowance
        </span>
        <span>Built with Arc, USDC, Gemini, ElevenLabs and QuickNode Streams.</span>
        <span>{USE_MOCK ? "Showing demo data, no real payments." : "Payments use test USDC on Arc Testnet."}</span>
      </div>
    </footer>
  );
}
