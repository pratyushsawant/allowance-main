/**
 * Percentage display: exact where the price allows, one decimal at most, never normalized.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPercent } from "./percent.ts";

const p6 = (v: bigint) => formatPercent(v, 6);

test("cent prices and their midpoints are shown exactly", () => {
  assert.equal(p6(520_000n), "52%");
  assert.equal(p6(515_000n), "51.5%");
  assert.equal(p6(485_000n), "48.5%");
  assert.equal(p6(5_000n), "0.5%");
  assert.equal(p6(0n), "0%");
  assert.equal(p6(1_000_000n), "100%");
});

test("finer values round half up at 0.1 point", () => {
  assert.equal(p6(333_500n), "33.4%"); // 33.35 -> 33.4
  assert.equal(p6(333_499n), "33.3%");
  assert.equal(p6(999_960n), "100%"); // 99.996 -> 100.0
  assert.equal(p6(400n), "0%"); // 0.04 points
  assert.equal(p6(500n), "0.1%"); // 0.05 points rounds up
});

test("sums above or below 100% are shown as they are", () => {
  assert.equal(p6(1_020_000n), "102%");
  assert.equal(p6(1_005_000n), "100.5%");
  assert.equal(p6(980_000n), "98%");
});

test("other scales and bad input", () => {
  assert.equal(formatPercent(515n, 3), "51.5%");
  assert.equal(formatPercent(1n, 0), "100%");
  assert.throws(() => p6(-1n), RangeError);
  assert.throws(() => formatPercent(1n, -1), RangeError);
  assert.throws(() => formatPercent(1n, 1.5), RangeError);
});
