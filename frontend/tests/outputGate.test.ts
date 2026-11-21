import { test } from "node:test";
import assert from "node:assert/strict";
import { createOutputGate } from "../src/outputGate.ts";
import { fakeTimers } from "./fakeTimers.ts";

function setup() {
  const clock = fakeTimers();
  const volumes: number[] = [];
  const gate = createOutputGate((v) => volumes.push(v), clock, 1500);
  return { clock, volumes, gate, last: () => volumes.at(-1) };
}

test("muting while the agent speaks silences it at once", () => {
  const { gate, last } = setup();
  gate.reapply();
  gate.mode("speaking");
  assert.equal(last(), 1);
  gate.setMuted(true);
  assert.equal(last(), 0);
  assert.equal(gate.volume(), 0);
});

test("unmuting during a muted reply doesn't bring that reply back", () => {
  const { gate, clock, last } = setup();
  gate.mode("speaking");
  gate.setMuted(true);
  clock.advance(500);
  gate.setMuted(false); // still speaking: stays silent
  assert.equal(last(), 0);
  gate.mode("listening"); // a pause between sentences
  clock.advance(800);
  gate.mode("speaking"); // the same reply goes on
  assert.equal(last(), 0, "the muted reply stays silent after a short pause");
  gate.mode("listening");
  clock.advance(1499);
  assert.equal(last(), 0);
  clock.advance(1);
  assert.equal(last(), 1, "sound returns once the agent has been quiet for 1.5 s");
});

test("unmuting right after a reply ends waits out the quiet period", () => {
  const { gate, clock, last } = setup();
  gate.setMuted(true);
  gate.mode("speaking");
  gate.mode("listening");
  clock.advance(200);
  gate.setMuted(false);
  assert.equal(last(), 0);
  clock.advance(1500);
  assert.equal(last(), 1);
});

test("unmuting while the agent is idle restores sound immediately", () => {
  const { gate, clock, last } = setup();
  gate.setMuted(true);
  clock.advance(10_000);
  gate.setMuted(false);
  assert.equal(last(), 1);
});

test("a new spoken turn after unmuting makes the next reply audible", () => {
  const { gate, last } = setup();
  gate.mode("speaking");
  gate.setMuted(true);
  gate.setMuted(false);
  assert.equal(last(), 0);
  gate.userTurn(); // the person spoke: the old reply was cut off by the interruption
  assert.equal(last(), 1);
});

test("a new spoken turn doesn't override mute", () => {
  const { gate, last } = setup();
  gate.setMuted(true);
  gate.userTurn();
  gate.mode("speaking");
  assert.equal(last(), 0);
  assert.equal(gate.volume(), 0);
});

test("typing a message silences the agent until the next spoken turn, not just a pause", () => {
  const { gate, clock, last } = setup();
  gate.mode("speaking");
  gate.supersede();
  assert.equal(last(), 0);
  gate.mode("listening");
  clock.advance(60_000);
  gate.mode("speaking"); // the answer to the earlier spoken turn arrives late
  assert.equal(last(), 0, "stale speech stays silent");
  gate.userTurn();
  assert.equal(last(), 1);
});

test("every speaking start re-applies mute (a new WebRTC audio element starts at full volume)", () => {
  const { gate, volumes } = setup();
  gate.setMuted(true);
  const before = volumes.length;
  gate.mode("speaking");
  gate.mode("listening");
  gate.mode("speaking");
  assert.deepEqual(volumes.slice(before), [0, 0]);
});

test("reset keeps mute but clears holds", () => {
  const { gate, last } = setup();
  gate.supersede();
  gate.reset();
  gate.reapply();
  assert.equal(last(), 1);
  gate.setMuted(true);
  gate.reset();
  gate.reapply();
  assert.equal(last(), 0);
});
