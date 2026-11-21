// Output volume for the ElevenLabs voice agent: mute, and silencing a reply the person moved past.
//
// Audio is only ever silenced, never paused, so a reply that was muted or superseded can't pick up
// where it stopped. After unmuting, sound comes back once the agent has been quiet for `quietMs` (the
// muted reply is over) or the person starts a new spoken turn, whichever comes first. Interruptions
// themselves are handled by ElevenLabs: its turn detection hears the person and stops the agent's audio
// on the server, and the SDK drops audio from before the interruption.
//
// No browser or SDK imports, so it can be tested on its own (tests/outputGate.test.ts).

export type Mode = "speaking" | "listening";

export type GateTimers = {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const realTimers: GateTimers = {
  now: () => Date.now(),
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

type Hold = "none" | "until_quiet" | "until_user_turn";

export function createOutputGate(setVolume: (volume: number) => void, timers: GateTimers = realTimers, quietMs = 1500) {
  let muted = false;
  let hold: Hold = "none";
  let speaking = false;
  let lastSpeechAt = Number.NEGATIVE_INFINITY;
  let quietTimer: unknown = null;
  let applied: number | null = null;

  const volume = () => (muted || hold !== "none" ? 0 : 1);
  const apply = (force = false) => {
    const v = volume();
    if (!force && v === applied) return;
    applied = v;
    setVolume(v);
  };
  const audioMayBePlaying = () => speaking || timers.now() - lastSpeechAt < quietMs;
  const clearQuiet = () => {
    if (quietTimer !== null) timers.clear(quietTimer);
    quietTimer = null;
  };
  const armQuiet = () => {
    clearQuiet();
    quietTimer = timers.set(() => {
      quietTimer = null;
      if (!speaking && hold === "until_quiet") {
        hold = "none";
        apply();
      }
    }, quietMs);
  };

  return {
    /** The volume the agent's audio should have right now (0 or 1). */
    volume,
    get muted() {
      return muted;
    },
    /** Mute takes effect at once. Unmute waits until any muted reply is over. */
    setMuted(next: boolean) {
      if (next === muted) return;
      muted = next;
      if (!muted && audioMayBePlaying() && hold === "none") {
        hold = "until_quiet";
        if (!speaking) armQuiet();
      }
      apply();
    },
    /** The SDK's mode: "speaking" while the agent's audio plays. */
    mode(mode: Mode) {
      if (mode === "speaking") {
        speaking = true;
        lastSpeechAt = timers.now();
        clearQuiet();
        apply(true); // re-assert: a newly attached audio element starts at full volume
      } else {
        if (speaking) lastSpeechAt = timers.now();
        speaking = false;
        if (hold === "until_quiet") armQuiet();
      }
    },
    /** A finalized user transcript: the person took a new spoken turn, so its reply may be heard. */
    userTurn() {
      clearQuiet();
      if (hold === "none") return;
      hold = "none";
      apply();
    },
    /** The person moved on (typed a message): silence the agent until their next spoken turn. */
    supersede() {
      clearQuiet();
      hold = "until_user_turn";
      apply();
    },
    /** Apply the current volume again (new session, new audio element). */
    reapply() {
      apply(true);
    },
    /** The voice session ended. Mute is kept; everything else starts fresh. */
    reset() {
      clearQuiet();
      speaking = false;
      lastSpeechAt = Number.NEGATIVE_INFINITY;
      hold = "none";
      applied = null;
    },
  };
}

export type OutputGate = ReturnType<typeof createOutputGate>;
