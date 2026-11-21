// Shared voice state. VoiceBridge (ElevenLabs) registers its controls here; the API layer and the
// voice panel read it. When ElevenLabs isn't configured on the backend, `available` is false and
// the app uses the browser's own speech recognition and read-aloud (speech, below).
//
// Input mode is decided per turn, not globally: a typed message gets a text answer only, a spoken one
// gets text plus speech unless spoken replies are muted. Muting only changes local audio. It never
// sends, repeats or cancels a message.
import { useSyncExternalStore } from "react";
import { createSpeechOutput } from "./speechOutput";

export type VoiceStatus = "disconnected" | "connecting" | "connected" | "disconnecting" | "error";
export type VoiceState = {
  available: boolean | null;
  status: VoiceStatus;
  error?: string;
  /** "Mute spoken replies": answers still appear as text; the microphone keeps working. */
  muted: boolean;
};

export type VoiceControls = {
  start(): Promise<void>;
  stop(): void;
  /** Background context that doesn't trigger a reply. */
  context(text: string): void;
  /** The person is typing: ElevenLabs waits a moment before speaking (SDK sendUserActivity). */
  userActivity(): void;
  /** The person moved on by typing: silence the agent's current or upcoming speech until their next spoken turn. */
  supersede(): void;
};

const MUTE_KEY = "allowance.muteSpokenReplies";
const readMuted = () => {
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
};

let state: VoiceState = { available: null, status: "disconnected", muted: readMuted() };
const subs = new Set<() => void>();
let controls: VoiceControls | null = null;

export const voice = {
  get: () => state,
  set(next: Partial<VoiceState>) {
    state = { ...state, ...next };
    subs.forEach((s) => s());
  },
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => {
      subs.delete(fn);
    };
  },
  register(c: VoiceControls | null) {
    controls = c;
  },
  connected: () => state.status === "connected" && controls !== null,
  controls: () => controls,
  /** Mute or unmute spoken replies. Stops any reading at once; never resends anything. */
  setMuted(muted: boolean) {
    if (muted === state.muted) return;
    try {
      window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      // private mode or blocked storage: the setting lasts for this page only
    }
    if (muted) speech.interrupt();
    voice.set({ muted });
  },
};

/** Browser read-aloud for replies to spoken turns (the path without ElevenLabs). */
export const speech = createSpeechOutput({
  synth: () => (typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null),
  utterance: (text) => new SpeechSynthesisUtterance(text),
  muted: () => state.muted,
});

export function useVoice(): VoiceState {
  return useSyncExternalStore(voice.subscribe, voice.get, voice.get);
}
