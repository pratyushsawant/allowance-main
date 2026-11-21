// Read-aloud for the browser voice path (used when ElevenLabs isn't configured): the browser's own
// speechSynthesis, and only for replies to spoken turns.
//
// - Speech is cancelled, never paused, so an interrupted reply can't resume.
// - Every spoken turn gets a token. Starting the mic, typing a new message or muting invalidates it,
//   so a reply that arrives late is shown as text but not read.
// - Nothing is read while the browser is listening, so the recognizer never hears the page talking.
//
// No browser imports (the synth is passed in), so it can be tested on its own (tests/speechOutput.test.ts).

export type Synth = { speak(utterance: unknown): void; cancel(): void };

export function createSpeechOutput(opts: {
  synth: () => Synth | null;
  utterance: (text: string) => unknown;
  muted: () => boolean;
  /** Chrome can drop a speak() made in the same tick as cancel(); speak on the next one. */
  defer?: (fn: () => void) => void;
}) {
  const defer = opts.defer ?? ((fn) => setTimeout(fn, 0));
  let token = 0;
  let listening = false;

  const interrupt = () => {
    token++;
    opts.synth()?.cancel();
  };

  return {
    supported: () => opts.synth() !== null,
    /** A spoken turn starts: stop any reading and return the token its reply must carry. */
    beginSpokenTurn() {
      interrupt();
      return token;
    },
    /** Stop reading now; any reply still on its way won't be read. */
    interrupt,
    /** The browser's speech recognizer is on (true) or off (false). */
    setListening(on: boolean) {
      listening = on;
      if (on) interrupt();
    },
    /** Read a reply for the turn that owns `forToken`. Returns whether it was queued. */
    speakReply(text: string, forToken: number) {
      const synth = opts.synth();
      const ok = () => forToken === token && !listening && !opts.muted();
      if (!synth || !text.trim() || !ok()) return false;
      synth.cancel();
      defer(() => {
        if (ok()) synth.speak(opts.utterance(text));
      });
      return true;
    },
  };
}

export type SpeechOutput = ReturnType<typeof createSpeechOutput>;
