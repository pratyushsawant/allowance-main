// ElevenLabs voice agent. Renders nothing; it connects the ElevenLabs React SDK to the backend.
//
// - The backend mints the conversation token (POST /api/voice/session); the ElevenLabs API key never
//   reaches the browser. While that endpoint answers 503 (not configured), voice stays off and the
//   app uses browser speech with the chat assistant; availability is re-checked every 2 minutes.
// - The agent's client tools call the backend with the AGENT session only and are read-only: the
//   `buy` tool never buys (purchases go through the chat assistant and its server-side gate).
// - Tool names and parameters must match backend/voice/client-tools.json, configured in ElevenLabs
//   with "Wait for response" on.
import { useEffect, useRef } from "react";
import { useConversation } from "@elevenlabs/react";
import { ApiError, backend, formatPct, hasSession, LoginCancelled, midOf, onLogin, type Purchase } from "../backend";
import { applyPurchase, emit, getCatalog } from "../realApi";
import { voice } from "../voice";

const RECHECK_MS = 120_000;

const slim = (p: Purchase) => ({
  id: p.id,
  item: p.item,
  state: p.state,
  priceUsdc: p.priceUsdc,
  reason: p.reason,
  next: p.next,
  summary: p.summary,
});

async function tool(run: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await run());
  } catch (err) {
    if (err instanceof LoginCancelled) return JSON.stringify({ error: "not_logged_in", message: "The person has not logged in." });
    if (err instanceof ApiError) return JSON.stringify({ error: err.code, message: err.message });
    return JSON.stringify({ error: "network_error", message: "Could not reach the Allowance backend." });
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));

const clientTools = {
  search_markets: (params: Record<string, unknown>) =>
    tool(async () =>
      (await backend.searchMarkets(str(params.query))).slice(0, 5).map((e) => ({
        ticker: e.ticker,
        title: e.title,
        category: e.category,
        contracts: e.contracts.slice(0, 8).map((c) => {
          const mid = midOf(c);
          return { label: c.label, impliedProbability: mid === null ? null : formatPct(mid) };
        }),
      })),
    ),
  list_catalog: () =>
    tool(async () =>
      (await getCatalog()).map((i) => ({
        item: i.id,
        title: i.title,
        priceUsdc: i.priceUsdc,
        seller: i.sellerName,
        sellerAllowlisted: i.sellerAllowlisted,
      })),
    ),
  // Purchases have one path: the chat assistant on the backend, where every request goes through the
  // purchase gate. The voice agent can look things up, but this tool never buys.
  buy: () =>
    tool(async () => ({
      error: "purchases_disabled_in_voice",
      message: "Purchases go through the chat assistant in this app, which checks each request. Ask the person to type the request in the chat.",
    })),
  get_purchase: (params: Record<string, unknown>) =>
    tool(async () => {
      const p = await backend.purchase(str(params.purchase_id));
      applyPurchase(p);
      return slim(p);
    }),
  check_budget: () =>
    tool(async () => {
      const b = await backend.budget();
      return {
        frozen: b.frozen,
        frozenReason: b.frozenReason,
        dailyCapUsdc: b.dailyCapUsdc,
        committedTodayUsdc: b.committedTodayUsdc,
        remainingTodayUsdc: b.remainingTodayUsdc,
        autoApproveMaxUsdc: b.autoApproveMaxUsdc,
        perCallMaxUsdc: b.perCallMaxUsdc,
      };
    }),
};

export function VoiceBridge() {
  const lastTyped = useRef<{ text: string; at: number } | null>(null);
  const conversation = useConversation({
    clientTools,
    onMessage: (m) => {
      if (!m.message) return;
      if (m.source === "user") {
        // Typed text is already in the chat; only add spoken transcripts.
        const t = lastTyped.current;
        if (t && t.text === m.message && Date.now() - t.at < 10_000) return;
        emit({ type: "user_message", text: m.message });
      } else {
        emit({ type: "agent_message", text: m.message, spoken: true });
      }
    },
    onStatusChange: ({ status }) => voice.set({ status }),
    onError: (message) => voice.set({ error: String(message) }),
  });

  // Keep the latest SDK methods reachable from outside React.
  const conv = useRef(conversation);
  useEffect(() => {
    conv.current = conversation;
  });

  useEffect(() => {
    voice.register({
      async start() {
        voice.set({ status: "connecting", error: undefined });
        try {
          const s = await backend.voiceSession();
          conv.current.startSession({ conversationToken: s.conversationToken, connectionType: "webrtc" });
        } catch (err) {
          const notConfigured = err instanceof ApiError && err.code === "voice_not_configured";
          voice.set({ status: "disconnected", available: notConfigured ? false : voice.get().available, error: notConfigured ? undefined : (err as Error).message });
        }
      },
      stop: () => conv.current.endSession(),
      send(text) {
        lastTyped.current = { text, at: Date.now() };
        conv.current.sendUserMessage(text);
      },
      context: (text) => conv.current.sendContextualUpdate(text),
    });
    return () => voice.register(null);
  }, []);

  // Is ElevenLabs configured on the backend? Asked after login and every 2 minutes while it isn't.
  // (The check mints one conversation token, which is simply not used.)
  useEffect(() => {
    let timer = 0;
    const check = async () => {
      window.clearTimeout(timer);
      if (!hasSession("agent")) return;
      try {
        await backend.voiceSession();
        voice.set({ available: true });
      } catch (err) {
        voice.set({ available: err instanceof ApiError && err.code === "voice_not_configured" ? false : voice.get().available });
      }
      if (!voice.get().available) timer = window.setTimeout(check, RECHECK_MS);
    };
    const off = onLogin((scope) => scope === "agent" && check());
    check();
    return () => {
      off();
      window.clearTimeout(timer);
    };
  }, []);

  return null;
}
