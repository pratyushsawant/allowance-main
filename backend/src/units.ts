/**
 * Integer-only amount helpers.
 *
 * Every function takes the token's decimals explicitly. Nothing here assumes
 * 6 or 18: callers read decimals from the SDK chain config and confirm them
 * onchain (see scripts/balance.ts). No helper rounds; anything that would lose
 * precision throws instead.
 */

const DECIMAL_STRING = /^(0|[1-9]\d*)(\.\d+)?$/;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`Invalid decimals: ${decimals}`);
  }
}

/** "0.005" with 6 decimals -> 5000n. Accepts an optional leading "$". Throws instead of rounding. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  assertDecimals(decimals);
  const text = amount.trim().replace(/^\$/, "");
  if (!DECIMAL_STRING.test(text)) {
    throw new Error(`Invalid decimal amount: "${amount}"`);
  }
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) {
    throw new Error(`"${amount}" has more than ${decimals} decimal places; refusing to round`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** 5000n with 6 decimals -> "0.005". Exact; trailing zeros trimmed. */
export function formatBaseUnits(value: bigint, decimals: number): string {
  assertDecimals(decimals);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = decimals === 0 ? "" : (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Exact conversion between two representations of the same asset, e.g. Arc's
 * 18-decimal native USDC and its 6-decimal ERC-20 interface. Throws if the
 * conversion would drop units (Arc's docs warn the 6-decimal view truncates).
 */
export function rescaleExact(value: bigint, fromDecimals: number, toDecimals: number): bigint {
  assertDecimals(fromDecimals);
  assertDecimals(toDecimals);
  if (toDecimals >= fromDecimals) return value * 10n ** BigInt(toDecimals - fromDecimals);
  const factor = 10n ** BigInt(fromDecimals - toDecimals);
  const remainder = value % factor;
  if (remainder !== 0n) {
    throw new Error(
      `Cannot convert ${value} from ${fromDecimals} to ${toDecimals} decimals without dropping ${remainder} base units`,
    );
  }
  return value / factor;
}
