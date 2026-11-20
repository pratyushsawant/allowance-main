import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBaseUnits, rescaleExact, toBaseUnits } from "./units.ts";

test("toBaseUnits converts decimal strings exactly", () => {
  assert.equal(toBaseUnits("0.005", 6), 5000n);
  assert.equal(toBaseUnits("$0.01", 6), 10000n);
  assert.equal(toBaseUnits("1", 6), 1_000_000n);
  assert.equal(toBaseUnits("1", 18), 10n ** 18n);
  assert.equal(toBaseUnits("0.000001", 6), 1n);
});

test("toBaseUnits refuses to round or parse ambiguous input", () => {
  assert.throws(() => toBaseUnits("0.0000001", 6), /refusing to round/);
  for (const bad of ["-1", "1e3", "", ".5", "01", "0.5.1", "abc"]) {
    assert.throws(() => toBaseUnits(bad, 6), /Invalid decimal amount/, bad);
  }
});

test("formatBaseUnits is exact", () => {
  assert.equal(formatBaseUnits(5000n, 6), "0.005");
  assert.equal(formatBaseUnits(1_000_000n, 6), "1");
  assert.equal(formatBaseUnits(0n, 6), "0");
  assert.equal(formatBaseUnits(10n ** 18n + 1n, 18), "1.000000000000000001");
});

test("rescaleExact converts 18 <-> 6 decimals and never truncates", () => {
  assert.equal(rescaleExact(5n * 10n ** 15n, 18, 6), 5000n); // 0.005 native -> ERC-20 units
  assert.equal(rescaleExact(5000n, 6, 18), 5n * 10n ** 15n);
  assert.throws(() => rescaleExact(10n ** 12n + 1n, 18, 6), /without dropping 1 base units/);
});
