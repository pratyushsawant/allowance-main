// One backend chat message per spoken turn.
//
// The ElevenLabs agent hears the person and calls the ask_allowance client tool, but that call doesn't
// define the turn. A turn is a finalized user transcript from ElevenLabs (it sends no partial ones to
// the page). The first ask_allowance call after it sends that transcript, word for word, to the
// server-side assistant, which owns the purchase gate. The message id is built from the voice session
// and the transcript's event id, so the same turn always has the same id. Any further call in the same
// turn gets the same answer with no new request, and the backend replays the stored answer for a
// repeated id anyway. A call with no new transcript waits briefly for one, and otherwise sends nothing.
//
// Only the latest transcript is sent, never several joined together: the purchase gate reads the start
// of the message ("wait", "stop", "cancel"), so "buy the brief" + "wait" must not become one message.
// Transcripts with no words (ElevenLabs sends "..." after a silence) are ignored.
//
// Turns run one at a time (the backend answers one message per conversation at a time). Nothing here
// cancels a request once it is sent: a purchase that started still stands, whatever happens to the
// audio, and its answer is shown as text.
//
// No browser or SDK imports, so it can be tested on its own (tests/voiceTurns.test.ts).
import type { AgentReply } from "./types";

export type VoiceReply = Pick<AgentReply, "text" | "status"> & {
  /** False when the chat was reset while waiting: don't show this answer in the new chat. */
  current?: boolean;
};

export type VoiceTurnDeps = {
  /** Send one message to the server-side assistant. Should not throw. */
  ask(text: string, messageId: string): Promise<VoiceReply>;
  /** A turn was sent: show a "thinking" placeholder with this id. */
  onPending(id: string): void;
  /** The assistant answered: replace the placeholder with this text. */
  onAnswer(id: string, reply: VoiceReply): void;
  /** How long a tool call waits for its transcript (ms). */
  waitMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
};

/** What the agent hears back when there is no new spoken request to answer. */
export const NO_NEW_REQUEST =
  "There is no new request from the person to answer. Don't repeat an earlier answer; ask them what they'd like to know.";
const FAILED = "I couldn't get an answer for that. Anything already paid for shows under Payments.";

type Transcript = { eventId: number; text: string };

/** "...", "…", "-": no words, nothing to answer. */
export const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text);
type Turn = { seq: number; answer: Promise<string>; answered: boolean };

/** Backend message ids are 8-64 characters of [A-Za-z0-9-]. */
export const voiceMessageId = (session: string, eventId: number) => `v-${session}-${eventId}`.slice(0, 64);

export function createVoiceTurns(deps: VoiceTurnDeps) {
  const waitMs = deps.waitMs ?? 6000;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let session = "";
  let seq = 0; // bumped by every finalized transcript
  let unsent: Transcript | null = null; // the latest finalized transcript not yet sent
  let latest: Turn | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let waiters: Array<() => void> = [];

  const wake = () => {
    const w = waiters;
    waiters = [];
    w.forEach((fn) => fn());
  };

  const waitForTranscript = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimer(timer);
        waiters = waiters.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimer(done, waitMs);
      waiters.push(done);
    });

  function send(t: Transcript): Promise<string> {
    unsent = null;
    const text = t.text;
    const messageId = voiceMessageId(session, t.eventId);
    const turn: Turn = { seq, answer: Promise.resolve(""), answered: false };
    latest = turn;
    deps.onPending(messageId);
    const run = queue.then(() => deps.ask(text, messageId));
    queue = run.catch(() => undefined);
    // The answer is shown even if the person interrupted, spoke again or ended the call meanwhile:
    // it says what the backend actually did.
    turn.answer = run
      .catch((): VoiceReply => ({ text: FAILED, status: "error" }))
      .then((reply) => {
        turn.answered = true;
        deps.onAnswer(messageId, reply);
        return reply.text;
      });
    return turn.answer;
  }

  return {
    /** A new voice session; its id becomes part of every message id. Unsent transcripts are dropped. */
    startSession(id: string) {
      session = id.replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || "s";
      seq = 0;
      unsent = null;
      latest = null;
      wake();
    },
    /** A finalized user transcript from ElevenLabs. */
    userTranscript(eventId: number, text: string) {
      const t = text.trim();
      if (!hasWords(t)) return;
      seq++;
      unsent = { eventId, text: t }; // a newer transcript replaces one the agent never sent
      wake();
    },
    /**
     * The agent called ask_allowance. Resolves with the text for the agent to say. The agent's own
     * `request` wording is ignored: the backend gets what the person actually said.
     */
    async toolCall(): Promise<string> {
      if (!unsent && latest && latest.seq === seq) return latest.answer; // same turn again
      if (!unsent) await waitForTranscript();
      if (!unsent) return latest && latest.seq === seq ? latest.answer : NO_NEW_REQUEST;
      return send(unsent);
    },
    /**
     * Should the agent's own words be shown? Not once the current turn's answer is on screen: what the
     * agent says then is that answer read aloud. Greetings and anything said before the answer are shown.
     */
    showAgentText(): boolean {
      return !(latest && latest.seq === seq && latest.answered);
    },
  };
}

export type VoiceTurns = ReturnType<typeof createVoiceTurns>;
