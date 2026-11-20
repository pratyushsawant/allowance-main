/**
 * What the agent can buy. Prices are decimal USDC strings, converted with the asset's decimals.
 * Whether a purchase is allowed is decided by the policy from the seller's actual 402 offer
 * (payee, amount), never from this listing.
 */
export type SellerId = "odds-desk" | "shady-reports";

export interface CatalogItem {
  id: string;
  sellerId: SellerId;
  title: string;
  description: string;
  priceUsdc: string;
  path: (ticker: string) => string;
}

export const SELLERS: Record<SellerId, { name: string; addressEnv: string }> = {
  "odds-desk": { name: "Odds Desk", addressEnv: "SELLER_ADDRESS" },
  "shady-reports": { name: "Shady Reports", addressEnv: "UNLISTED_SELLER_ADDRESS" },
};

export const CATALOG: readonly CatalogItem[] = [
  {
    id: "odds_snapshot", sellerId: "odds-desk", priceUsdc: "0.005",
    title: "Odds snapshot", description: "Current bid/ask for every contract in one event.",
    path: (t) => `/sellers/odds-desk/snapshot/${encodeURIComponent(t)}`,
  },
  {
    id: "odds_history", sellerId: "odds-desk", priceUsdc: "0.02",
    title: "Odds history and biggest movers", description: "Recorded prices since recording began, and the largest moves.",
    path: (t) => `/sellers/odds-desk/history/${encodeURIComponent(t)}`,
  },
  {
    id: "deep_brief", sellerId: "odds-desk", priceUsdc: "0.75",
    title: "Deep brief across related markets",
    description:
      "Analysis of one event from recorded prices: implied probabilities, spreads, and price movement where enough history has been recorded (it says when there isn't), plus related markets in the same category.",
    path: (t) => `/sellers/odds-desk/brief/${encodeURIComponent(t)}`,
  },
  {
    id: "full_report", sellerId: "shady-reports", priceUsdc: "0.01",
    title: "Full report", description: "Offered by a seller that is not on the allowlist.",
    path: (t) => `/sellers/shady-reports/full-report/${encodeURIComponent(t)}`,
  },
];

export function getItem(id: string): CatalogItem | undefined {
  return CATALOG.find((i) => i.id === id);
}

/** Gemini event tickers look like NCAAM-2611201730-MINN-OKST-M. */
export const TICKER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
