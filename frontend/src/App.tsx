import { useEffect, useState } from "react";
import { ConversationProvider } from "@elevenlabs/react";
import { useAllowance } from "./useAllowance";
import { USE_MOCK } from "./config";
import { AccessCodeDialog } from "./components/AccessCodeDialog";
import { ApprovalModal } from "./components/ApprovalModal";
import { VoiceBridge } from "./components/VoiceBridge";
import { DemoPage } from "./components/DemoPage";
import { HowItWorks } from "./landing/HowItWorks";
import { Announcement, Footer, Hero, Nav, RulesExplainer, scrollToId, type Page } from "./components/Landing";
import { MarketsPage } from "./components/MarketsPage";

// Tiny hash router: "#/markets" and "#/demo" are their own pages, anything else is home.
const HASH: Record<Page, string> = { home: "/", markets: "/markets", demo: "/demo" };
const pageFromHash = (): Page =>
  window.location.hash === "#/markets" ? "markets" : window.location.hash === "#/demo" ? "demo" : "home";

export default function App() {
  const a = useAllowance();
  const [page, setPage] = useState<Page>(pageFromHash);

  useEffect(() => {
    const onHash = () => {
      setPage(pageFromHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (next: Page, section?: string) => {
    if (next !== page) {
      window.location.hash = HASH[next];
      setPage(next);
      // Wait for the new page to render, then jump.
      setTimeout(() => (section && section !== "top" ? scrollToId(section) : window.scrollTo({ top: 0 })), 30);
    } else if (section === "top") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (section) {
      scrollToId(section);
    }
  };

  // The live demo needs a backend session: ask for the access code when the demo page opens.
  const { connect } = a;
  useEffect(() => {
    if (page === "demo") connect();
  }, [page, connect]);

  // Hero button: open the demo page and ask the question there.
  const tryQuestion = (text: string) => {
    go("demo");
    a.say(text);
  };

  return (
    <ConversationProvider>
      {!USE_MOCK && <VoiceBridge />}
      <AccessCodeDialog />
      {page === "home" && <Announcement onOpen={() => go("markets")} />}
      {page !== "demo" && <Nav page={page} go={go} />}

      {page === "home" && (
        <>
          <Hero onTry={tryQuestion} latest={a.payments[0]} />
          <HowItWorks />
          <RulesExplainer rules={a.rules} spentToday={a.spentToday} onOpenDemo={() => go("demo")} />
          <Footer />
        </>
      )}

      {page === "markets" && (
        <MarketsPage
          messages={a.messages}
          onSay={a.say}
          busy={a.busy}
          onStop={a.stop}
          spentToday={a.spentToday}
          budget={a.budget?.dailyCap ?? a.rules?.dailyBudget ?? 0}
          remainingLabel={a.budget?.remainingTodayLabel}
        />
      )}

      {/* The demo is a full app screen with its own sidebar, so it has no top nav. */}
      {page === "demo" && <DemoPage a={a} go={go} />}

      <ApprovalModal request={a.approval} rules={a.rules} spentToday={a.spentToday} budget={a.budget} onDecide={a.decide} />
    </ConversationProvider>
  );
}
