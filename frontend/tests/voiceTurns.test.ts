import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceTurns, NO_NEW_REQUEST, voiceMessageId, type VoiceReply } from "../src/voiceTurns.ts";
import { fakeTimers, flush } from "./fakeTimers.ts";

const BACKEND_ID = /^[A-Za-z0-9-]{8,64}$/; // backend/src/assistant.ts

function setup() {
  const clock = fakeTimers();
  const asks: Array<{ text: string; id: string; resolve: (r: VoiceReply) => void }> = [];
  const pending: string[] = [];
  const answers: Array<{ id: string; text: string }> = [];
  const turns = createVoiceTurns({
    ask: (text, id) => new Promise<VoiceReply>((resolve) => asks.push({ text, id, resolve })),
    onPending: (id) => pending.push(id),
    onAnswer: (id, r) => answers.push({ id, text: r.text }),
    waitMs: 6000,
    setTimer: clock.set,
    clearTimer: clock.clear,
  });
  turns.startSession("4f1c2a9e-77b0-4d2e-9a51-3c0e8b6d1f20");
  return { clock, asks, pending, answers, turns };
}

test("one spoken turn is sent once, even if the agent calls the tool twice", async () => {
  const { turns, asks, pending, answers } = setup();
  turns.userTranscript(12, "What are the BTC odds?");
  const a = turns.toolCall();
  const b = turns.toolCall(); // a duplicate while the first is running
  await flush();
  assert.equal(asks.length, 1);
  assert.equal(asks[0].text, "What are the BTC odds?");
  asks[0].resolve({ text: "62% yes.", status: "done" });
  assert.equal(await a, "62% yes.");
  assert.equal(await b, "62% yes.");
  const c = await turns.toolCall(); // and once more after it finished
  assert.equal(c, "62% yes.");
  assert.equal(asks.length, 1, "no second request to the backend");
  assert.equal(pending.length, 1);
  assert.equal(answers.length, 1);
});

test("the backend gets the person's transcript, not the agent's wording", async () => {
  const { turns, asks } = setup();
  turns.userTranscript(3, "wait, don't buy that");
  void turns.toolCall(); // the agent might paraphrase; the tool ignores its params
  await flush();
  assert.equal(asks[0].text, "wait, don't buy that");
});

test("a tool call that arrives before its transcript waits for the finalized one", async () => {
  const { turns, asks, clock } = setup();
  const call = turns.toolCall();
  await flush();
  assert.equal(asks.length, 0, "nothing is sent without a finalized transcript");
  clock.advance(2000);
  turns.userTranscript(5, "Get me a deep brief on Minnesota");
  await flush();
  assert.equal(asks.length, 1);
  assert.equal(asks[0].text, "Get me a deep brief on Minnesota");
  asks[0].resolve({ text: "That needs your approval.", status: "approval" });
  assert.equal(await call, "That needs your approval.");
});

test("a tool call with no new transcript sends nothing", async () => {
  const { turns, asks, clock } = setup();
  const call = turns.toolCall();
  clock.advance(6000);
  assert.equal(await call, NO_NEW_REQUEST);
  assert.equal(asks.length, 0);
});

test("turns run one at a time, and interrupting never cancels the turn already sent", async () => {
  const { turns, asks, answers } = setup();
  turns.userTranscript(10, "Buy the BTC snapshot");
  const first = turns.toolCall();
  await flush();
  turns.userTranscript(20, "stop, never mind"); // the person talks over the agent
  const second = turns.toolCall();
  await flush();
  assert.equal(asks.length, 1, "the second turn waits for the first to finish");
  asks[0].resolve({ text: "Bought the snapshot for 0.005 USDC.", status: "done" });
  assert.equal(await first, "Bought the snapshot for 0.005 USDC.");
  await flush();
  assert.equal(asks.length, 2);
  assert.equal(asks[1].text, "stop, never mind");
  assert.notEqual(asks[0].id, asks[1].id);
  asks[1].resolve({ text: "Okay, nothing more.", status: "done" });
  await second;
  assert.deepEqual(
    answers.map((a) => a.text),
    ["Bought the snapshot for 0.005 USDC.", "Okay, nothing more."],
    "the first answer is shown as text even though it was interrupted",
  );
});

test("an answer is still shown after the voice call ends", async () => {
  const { turns, asks, answers } = setup();
  turns.userTranscript(1, "BTC odds?");
  const call = turns.toolCall();
  await flush();
  turns.startSession("next-session"); // call ended, a new one started
  asks[0].resolve({ text: "55% yes.", status: "done" });
  await call;
  assert.deepEqual(answers.map((a) => a.text), ["55% yes."]);
});

test("message ids are stable per turn, valid for the backend, and differ across sessions", () => {
  const a = voiceMessageId("4f1c2a9e77b04d2e9a513c0e", 12);
  assert.equal(a, voiceMessageId("4f1c2a9e77b04d2e9a513c0e", 12));
  assert.notEqual(a, voiceMessageId("aaaaaaaaaaaaaaaaaaaaaaaa", 12));
  assert.notEqual(a, voiceMessageId("4f1c2a9e77b04d2e9a513c0e", 13));
  assert.match(a, BACKEND_ID);
  assert.match(voiceMessageId("4f1c2a9e77b04d2e9a513c0e", 123456789012), BACKEND_ID);
});

test("only the latest transcript is sent, so a 'wait' is never buried behind an earlier request", async () => {
  const { turns, asks } = setup();
  turns.userTranscript(4, "Buy the deep brief on Minnesota"); // the agent answered this itself
  turns.userTranscript(6, "wait");
  void turns.toolCall();
  void turns.toolCall();
  await flush();
  assert.equal(asks.length, 1);
  assert.equal(asks[0].text, "wait", "the server-side gate sees 'wait' at the start");
});

test("transcripts with no words are ignored (ElevenLabs sends '...' after a silence)", async () => {
  const { turns, asks, clock } = setup();
  turns.userTranscript(73, "...");
  turns.userTranscript(74, " … ");
  const call = turns.toolCall();
  clock.advance(6000);
  assert.equal(await call, NO_NEW_REQUEST);
  turns.userTranscript(86, "Wait, what can you do?");
  void turns.toolCall();
  await flush();
  assert.equal(asks.length, 1);
  assert.equal(asks[0].text, "Wait, what can you do?", "no '...' in front of 'Wait'");
});

test("the agent's read-aloud of a shown answer isn't shown twice", async () => {
  const { turns, asks } = setup();
  assert.equal(turns.showAgentText(), true, "the greeting is shown");
  turns.userTranscript(2, "BTC odds?");
  const call = turns.toolCall();
  await flush();
  assert.equal(turns.showAgentText(), true, "a filler line before the answer is shown");
  asks[0].resolve({ text: "62% yes.", status: "done" });
  await call;
  assert.equal(turns.showAgentText(), false, "the agent reading the answer is not shown again");
  turns.userTranscript(3, "thanks");
  assert.equal(turns.showAgentText(), true);
});
