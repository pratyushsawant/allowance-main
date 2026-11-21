// ElevenLabs voice agent. Renders nothing; it connects the ElevenLabs React SDK to the backend.
//
// - The backend mints the conversation token (POST /api/voice/session); the ElevenLabs API key never
//   reaches the browser. While that endpoint answers 503 (not configured), voice stays off and the
//   app uses browser speech with the chat assistant; availability is re-checked every 2 minutes.
// - Listening, turn-taking and interruption are ElevenLabs' own: its turn detection waits for the end
//   of the person's utterance, and when the person talks over the agent it stops the agent's audio on
//   the server (the SDK also drops audio from before an interruption). The microphone goes through
//   WebRTC with the browser's echo cancellation, noise suppression and voice isolation, so the agent's
//   own voice isn't taken for the person's.
// - Each finalized transcript is one turn, sent once to the server-side assistant (voiceTurns.ts). Its
//   answer is shown as text as soon as it arrives, whatever happens to the audio; the agent reads it.
// - Typed messages never go to ElevenLabs: they get a text answer from the chat assistant only, and
//   any speech still playing from an earlier spoken turn is silenced (outputGate.ts).
// - "Mute spoken replies" sets the agent's output volume to 0 (outputGate.ts). The mic stays on.
// - Tool names and parameters must match the agent's tools in ElevenLabs ("Wait for response" on).
//   The agent is configured with ask_allowance only; the others are read-only, and `buy` never buys.
import { useEffect, useRef } from "react";
import { useConversation } from "@elevenlabs/react";
import { ApiError, backend, formatPct, hasSession, LoginCancelled, midOf, onLogin, type Purchase } from "../backend";
import { createOutputGate } from "../outputGate";
import { applyPurchase, askFromVoice, emit, getCatalog } from "../realApi";
import { speech, voice } from "../voice";
import { createVoiceTurns, hasWords } from "../voiceTurns";

const RECHECK_MS = 120_000;

// One voice agent per page, so these live at module level (the client tools below need them).
let setAgentVolume: (volume: number) => void = () => {};
const gate = createOutputGate((v) => setAgentVolume(v));
const turns = createVoiceTurns({
  ask: askFromVoice,
  onPending: (id) => emit({ type: "agent_pending", id }),
  onAnswer: (id, reply) => {
    if (reply.current !== false) emit({ type: "agent_message", id, text: reply.text, status: reply.status, spoken: true });
  },
});

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
  // The main tool: the person's latest spoken turn goes to the Allowance assistant (Claude on the
  // backend), once, and the agent speaks its answer. Purchases happen only there, behind the backend's
  // purchase gate. The agent's `request` wording is ignored in favour of the person's own transcript.
  ask_allowance: () => turns.toolCall(),
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
      message: "Purchases go through the Allowance assistant (ask_allowance), which checks each request.",
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
  const conversation = useConversation({
    clientTools,
    // The SDK removes expressive delivery tags like "[happy]" from the agent's text.
    stripAudioTags: true,
    onMessage: (m) => {
      const text = m.message?.trim() ?? "";
      if (!hasWords(text)) return; // "..." after a silence: nothing was said
      if (m.source === "user") {
        // A finalized transcript: one spoken turn.
        turns.userTranscript(m.event_id, text);
        gate.userTurn();
        emit({ type: "user_message", text, via: "spoken" });
      } else if (turns.showAgentText()) {
        // Greetings and anything said before the answer. Once the answer is on screen (from
        // ask_allowance), the agent is reading it aloud, so it isn't shown twice.
        emit({ type: "agent_message", text, spoken: true });
      }
    },
    onModeChange: ({ mode }) => gate.mode(mode),
    onConnect: () => gate.reapply(),
    // WebRTC attaches a fresh audio element at full volume: apply mute to it straight away.
    onDebug: (e: unknown) => {
      if (e && typeof e === "object" && (e as { type?: unknown }).type === "audio_element_ready") gate.reapply();
    },
    onDisconnect: () => gate.reset(),
    onStatusChange: ({ status }) => voice.set({ status }),
    onError: (message) => voice.set({ error: String(message) }),
  });

  // Keep the latest SDK methods reachable from outside React.
  const conv = useRef(conversation);
  useEffect(() => {
    conv.current = conversation;
  });

  useEffect(() => {
    // The SDK's controls throw when no voice session is active; these are best-effort.
    const live = () => voice.get().status === "connected";
    setAgentVolume = (volume) => {
      try {
        conv.current.setVolume({ volume });
      } catch {
        // no session yet (or it ended): the next one gets the volume on connect
      }
    };
    voice.register({
      async start() {
        voice.set({ status: "connecting", error: undefined });
        speech.interrupt(); // no browser read-aloud while the agent is on
        try {
          const s = await backend.voiceSession();
          turns.startSession(crypto.randomUUID());
          gate.reset();
          conv.current.startSession({ conversationToken: s.conversationToken, connectionType: "webrtc" });
        } catch (err) {
          const notConfigured = err instanceof ApiError && err.code === "voice_not_configured";
          voice.set({ status: "disconnected", available: notConfigured ? false : voice.get().available, error: notConfigured ? undefined : (err as Error).message });
        }
      },
      stop: () => conv.current.endSession(),
      context(text) {
        if (!live()) return;
        try {
          conv.current.sendContextualUpdate(text);
        } catch {
          // not connected any more: nothing to tell
        }
      },
      userActivity() {
        if (!live()) return;
        try {
          conv.current.sendUserActivity();
        } catch {
          // not connected any more
        }
      },
      supersede: () => gate.supersede(),
    });
    return () => {
      voice.register(null);
      setAgentVolume = () => {};
    };
  }, []);

  // "Mute spoken replies" drives the agent's output volume. It never sends anything to the agent.
  useEffect(() => {
    gate.setMuted(voice.get().muted);
    return voice.subscribe(() => gate.setMuted(voice.get().muted));
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
