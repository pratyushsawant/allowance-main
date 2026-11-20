/**
 * Probabilities shown as percentages.
 *
 * Each value is formatted on its own from the exact probability. A set of values is never adjusted
 * so that it adds up to 100%: market prices carry spread and overround, and hiding that would
 * misstate the market. For a total, format the exact sum of the underlying probabilities (the deep
 * brief's `probabilitiesSum`); never add rounded percentages.
 *
 * At most one decimal place. That is exact for cent-priced contracts and their bid/ask midpoints
 * (0.515 -> "51.5%"); finer values round half up at 0.1 point (0.3335 -> "33.4%").
 */
export function formatPercent(probability: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError("decimals must be a non-negative integer");
  if (probability < 0n) throw new RangeError("probability must not be negative");
  const scale = 10n ** BigInt(decimals);
  const tenths = (probability * 1000n + scale / 2n) / scale;
  const whole = tenths / 10n;
  const fraction = tenths % 10n;
  return fraction === 0n ? `${whole}%` : `${whole}.${fraction}%`;
}
