// Shared voice state. VoiceBridge (ElevenLabs) registers its controls here; the API layer and the
// voice panel read it. When ElevenLabs isn't configured on the backend, `available` is false and
// the app uses the text agent plus the browser's own speech.
import { useSyncExternalStore } from "react";

export type VoiceStatus = "disconnected" | "connecting" | "connected" | "disconnecting" | "error";
export type VoiceState = { available: boolean | null; status: VoiceStatus; error?: string };

export type VoiceControls = {
  start(): Promise<void>;
  stop(): void;
  /** A user turn (typed text, or an app event such as an approval). */
  send(text: string): void;
  /** Background context that doesn't trigger a reply. */
  context(text: string): void;
};

let state: VoiceState = { available: null, status: "disconnected" };
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
};

export function useVoice(): VoiceState {
  return useSyncExternalStore(voice.subscribe, voice.get, voice.get);
}
