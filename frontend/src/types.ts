// The data shapes the UI works with. src/realApi.ts maps the backend's responses into these
// (src/api.ts has the offline mock). If the backend sends something different, change it HERE
// first — TypeScript will then point at every spot in the UI that needs updating.

export type Rules = {
  allowlist: string[]; // seller names the agent may pay
  perRequestCap: number; // max USDC for a single request
  dailyBudget: number; // max USDC per day
  approvalThreshold: number; // above this, a human must approve
  /** false when the limits are server config (the real backend); the panel is then read-only. */
  editable?: boolean;
  /** Spending kill switch (operator only on the real backend). */
  frozen?: boolean;
  frozenReason?: string | null;
};

/** Today's spend as the backend counts it (GET /api/budget). Labels are the backend's exact decimals. */
export type Budget = {
  spentToday: number; // committed today: paid + held, USDC
  spentTodayLabel: string; // exact decimal string, e.g. "0.755"
  remainingToday: number;
  remainingTodayLabel: string;
  dailyCap: number;
  dailyCapLabel: string;
  availableFunds: number | null; // spendable Circle Gateway balance, USDC (null = backend couldn't read it)
  availableFundsLabel: string | null;
  day: string; // YYYY-MM-DD in `timeZone`
  timeZone: string; // the backend's budget day, e.g. "America/Chicago"
};

/**
 * One purchase as the payments list shows it.
 * - awaiting: over the auto-approve limit, waiting for a person; nothing reserved yet
 * - pending: budget held or payment in flight
 * - confirmed: paid (Gateway accepted it); onchain settlement follows, see txHash
 * - review: Gateway reported a problem after acceptance; held for a person to check
 * - not_charged: blocked, declined, expired approval, aborted, rejected or expired; nothing was paid
 */
export type PaymentStatus = "awaiting" | "pending" | "confirmed" | "review" | "not_charged";

export type MarketData = {
  market: string; // event title
  yesPrice: number; // 0–1, i.e. implied probability of the leading outcome
  yesLabel?: string; // what the number refers to, e.g. "Minnesota"
  volume?: number;
};

export type Payment = {
  id: string;
  seller: string;
  amount: number; // USDC
  amountLabel?: string; // exact decimal string from the backend, e.g. "0.005"
  txHash: string; // onchain settlement tx; "" until the batch settles
  status: PaymentStatus;
  timestamp: number; // ms since epoch
  data?: MarketData; // what the payment bought
  item?: string;
  itemTitle?: string;
  summary?: string | null;
  /** The backend's raw purchase state, e.g. "blocked" or "settled". */
  state?: string;
  /** Why it was blocked/declined/held, from the backend. */
  reason?: string | null;
};

/** A USDC transfer that QuickNode Streams saw involving the agent wallet (GET /api/chain/movements). */
export type Movement = {
  id: string; // canonical id: chain:tx:logIndex
  kind: string; // top_up | gateway_deposit | gateway_withdrawal | unexpected_outbound | unrelated
  label: string;
  amountLabel: string;
  txHash: string;
  explorerUrl: string;
  block: number | null;
  observedAt: number;
  alert: boolean; // an unexpected transfer out (the backend freezes spending when it sees one)
};

/**
 * Backend session, as far as the browser knows.
 * logged_out: never logged in this page; expired: the session ran out (log in again);
 * unreachable: requests are failing (retrying with backoff); connected: polling works.
 */
export type Connection = "logged_out" | "connected" | "expired" | "unreachable";

export type ApprovalRequest = {
  id: string;
  seller: string;
  amount: number;
  amountLabel?: string;
  reason: string; // what the agent wants to buy and why
  expiresAt?: number | null;
};

/**
 * thinking/fetching: waiting for the assistant; approval: a purchase waits for a person;
 * incomplete: the assistant stopped before finishing (step or length limit).
 */
export type ChatStatus = "thinking" | "fetching" | "done" | "approval" | "incomplete" | "error" | "canceled";

export type ChatMessage = {
  id: string;
  /** "system": an app notice (freeze changed, onchain transfer seen), not written by the AI. */
  from: "user" | "agent" | "system";
  text: string;
  status?: ChatStatus;
  /** Spoken already (ElevenLabs speaks its own replies), so the browser shouldn't read it aloud. */
  spoken?: boolean;
  /** When it was said (ms), when known. */
  at?: number;
};

/** The assistant's answer to one message. */
export type AgentReply = { text: string; status: Exclude<ChatStatus, "thinking" | "fetching"> };

// Everything the backend layer can send to the UI.
export type ServerEvent =
  | { type: "payment"; payment: Payment } // new payment OR status update (same id)
  | { type: "approval_request"; request: ApprovalRequest }
  | { type: "approval_resolved"; id: string }
  | { type: "agent_message"; text: string; spoken?: boolean }
  | { type: "notice"; text: string; tone?: "info" | "warn" }
  | { type: "user_message"; text: string } // e.g. an ElevenLabs voice transcript
  | { type: "rules"; rules: Rules }
  | { type: "budget"; budget: Budget }
  | { type: "movements"; movements: Movement[] }
  | { type: "connection"; connection: Connection };
