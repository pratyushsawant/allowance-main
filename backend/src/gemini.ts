/**
 * Gemini Prediction Markets public REST client (no auth).
 * Shape checked live on 2026-11-20: GET /v1/prediction-markets/events?status=active&limit&offset
 * returns { data: Event[], pagination: { limit, offset, total } }; each contract carries
 * prices.bestBid / bestAsk (decimal strings) and sometimes prices.lastTradePrice.
 * No rate limits are documented, so callers page slowly and back off on 429/5xx.
 */
export const GEMINI_API_BASE = "https://api.gemini.com";
const USER_AGENT = "allowance-backend/0.1 (hackathon prototype)";
const REQUEST_TIMEOUT_MS = 20_000;

export interface GeminiPrices {
  bestBid?: string;
  bestAsk?: string;
  lastTradePrice?: string;
}

export interface GeminiContract {
  id: string;
  label?: string;
  ticker?: string;
  instrumentSymbol?: string;
  status?: string;
  marketState?: string;
  prices?: GeminiPrices;
}

export interface GeminiEvent {
  id: string;
  ticker: string;
  title: string;
  category?: string;
  status?: string;
  volume?: string;
  volume24h?: string;
  startTime?: string;
  expiryDate?: string;
  contracts?: GeminiContract[];
}

export interface EventsPage {
  data: GeminiEvent[];
  pagination: { limit: number; offset: number; total: number };
}

export class GeminiHttpError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;
  constructor(status: number, retryAfterSeconds: number | undefined) {
    super(`Gemini API returned HTTP ${status}`);
    this.name = "GeminiHttpError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type FetchEventsPage = (offset: number, limit: number) => Promise<EventsPage>;

export const fetchActiveEventsPage: FetchEventsPage = async (offset, limit) => {
  const url = `${GEMINI_API_BASE}/v1/prediction-markets/events?status=active&limit=${limit}&offset=${offset}`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new GeminiHttpError(res.status, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
  }
  const body = (await res.json()) as Partial<EventsPage>;
  if (!Array.isArray(body.data) || typeof body.pagination?.total !== "number") {
    throw new Error("Unexpected Gemini events response shape");
  }
  return body as EventsPage;
};

const DECIMAL = /^\d+(\.\d+)?$/;
/** Keeps a price only if it is a plain non-negative decimal string; otherwise null. Never parses to float. */
export function cleanPrice(value: unknown): string | null {
  return typeof value === "string" && DECIMAL.test(value) ? value : null;
}
