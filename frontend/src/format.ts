// USDC amounts: at least 2 decimals, up to 3, so 0.005 and 0.755 aren't rounded away
// (2 → "2.00", 0.75 → "0.75", 0.005 → "0.005", 1.245 → "1.245").
export const usd = (n: number) => n.toFixed(3).replace(/(\.\d\d)0$/, "$1");
