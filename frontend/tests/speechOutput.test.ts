import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpeechOutput } from "../src/speechOutput.ts";

function setup() {
  const said: string[] = [];
  let cancels = 0;
  let muted = false;
  const deferred: Array<() => void> = [];
  const out = createSpeechOutput({
    synth: () => ({ speak: (u) => said.push(u as string), cancel: () => cancels++ }),
    utterance: (text) => text,
    muted: () => muted,
    defer: (fn) => deferred.push(fn),
  });
  const runDeferred = () => deferred.splice(0).forEach((fn) => fn());
  return { out, said, cancels: () => cancels, setMuted: (m: boolean) => (muted = m), runDeferred };
}

test("a spoken turn's reply is read aloud", () => {
  const { out, said, runDeferred } = setup();
  const t = out.beginSpokenTurn();
  assert.equal(out.speakReply("62% yes.", t), true);
  runDeferred();
  assert.deepEqual(said, ["62% yes."]);
});

test("a reply is not read once the person has moved on (typed, or started the mic)", () => {
  const { out, said, runDeferred } = setup();
  const t = out.beginSpokenTurn();
  out.interrupt(); // typed a message
  assert.equal(out.speakReply("late answer", t), false);
  const t2 = out.beginSpokenTurn();
  out.setListening(true); // tapped the mic
  assert.equal(out.speakReply("late answer", t2), false);
  runDeferred();
  assert.deepEqual(said, []);
});

test("nothing is read while the browser is listening", () => {
  const { out, said, runDeferred } = setup();
  out.setListening(true);
  const t = out.beginSpokenTurn();
  assert.equal(out.speakReply("hello", t), false);
  out.setListening(false);
  runDeferred();
  assert.deepEqual(said, []);
});

test("muted: replies are not read, including one already queued", () => {
  const { out, said, setMuted, runDeferred } = setup();
  setMuted(true);
  assert.equal(out.speakReply("hello", out.beginSpokenTurn()), false);
  setMuted(false);
  const t = out.beginSpokenTurn();
  assert.equal(out.speakReply("queued", t), true);
  setMuted(true); // muted before it started
  runDeferred();
  assert.deepEqual(said, []);
});

test("interrupting cancels speech, and a newer turn makes the older one stale", () => {
  const { out, said, cancels, runDeferred } = setup();
  const before = cancels();
  const first = out.beginSpokenTurn();
  const second = out.beginSpokenTurn();
  assert.ok(cancels() > before, "starting a turn stops any reading");
  assert.equal(out.speakReply("first answer", first), false);
  assert.equal(out.speakReply("second answer", second), true);
  runDeferred();
  assert.deepEqual(said, ["second answer"]);
  const c = cancels();
  out.interrupt();
  assert.equal(cancels(), c + 1);
});

test("no synthesizer: nothing to read", () => {
  const out = createSpeechOutput({ synth: () => null, utterance: (t) => t, muted: () => false });
  assert.equal(out.supported(), false);
  assert.equal(out.speakReply("hi", out.beginSpokenTurn()), false);
});
