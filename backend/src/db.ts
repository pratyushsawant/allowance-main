/**
 * SQLite access. One file, WAL mode, ordered migrations.
 * Money columns are INTEGER base units; read them with statement.safeIntegers(true) so they come back as BigInt.
 * Timestamps are INTEGER milliseconds since epoch (safe as JS numbers).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export type DB = Database.Database;

export const DEFAULT_DB_PATH = fileURLToPath(new URL("../data/allowance.db", import.meta.url));

/** Append-only. Never edit a shipped migration; add a new one. */
const MIGRATIONS: string[] = [
  // 1: Gemini odds recorder
  `
  CREATE TABLE gemini_events (
    ticker        TEXT PRIMARY KEY,
    event_id      TEXT NOT NULL,
    title         TEXT NOT NULL,
    category      TEXT,
    status        TEXT,
    volume        TEXT,
    volume_24h    TEXT,
    start_time    TEXT,
    expiry_date   TEXT,
    first_seen_at INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL
  );
  CREATE TABLE gemini_contracts (
    instrument_symbol TEXT PRIMARY KEY,
    event_ticker      TEXT NOT NULL REFERENCES gemini_events(ticker),
    contract_id       TEXT NOT NULL,
    label             TEXT,
    ticker            TEXT,
    status            TEXT,
    market_state      TEXT,
    last_seen_at      INTEGER NOT NULL
  );
  CREATE INDEX gemini_contracts_event ON gemini_contracts(event_ticker);
  CREATE TABLE recorder_polls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    pages       INTEGER,
    events      INTEGER,
    contracts   INTEGER,
    snapshots   INTEGER,
    error       TEXT
  );
  -- Prices are stored exactly as Gemini sends them (decimal strings, USD per contract). No floats.
  -- A row is written when any price changes, plus a heartbeat row so flat periods are still covered.
  CREATE TABLE odds_snapshots (
    instrument_symbol TEXT NOT NULL REFERENCES gemini_contracts(instrument_symbol),
    observed_at       INTEGER NOT NULL,
    best_bid          TEXT,
    best_ask          TEXT,
    last_trade_price  TEXT,
    poll_id           INTEGER NOT NULL REFERENCES recorder_polls(id),
    PRIMARY KEY (instrument_symbol, observed_at)
  ) WITHOUT ROWID;
  `,
  // 2: purchases ledger, audit trail, freeze switch
  `
  CREATE TABLE purchases (
    id                  TEXT PRIMARY KEY,
    idempotency_key     TEXT NOT NULL UNIQUE,
    item_id             TEXT NOT NULL,
    seller_id           TEXT NOT NULL,
    resource_url        TEXT NOT NULL,
    pay_to              TEXT NOT NULL,
    asset               TEXT NOT NULL,
    network             TEXT NOT NULL,
    amount              INTEGER NOT NULL CHECK (amount > 0),
    budget_day          TEXT NOT NULL,
    state               TEXT NOT NULL CHECK (state IN (
                          'blocked','awaiting_approval','declined','approval_expired',
                          'reserved','aborted','signed','accepted','settled',
                          'rejected','pending_unknown','expired','needs_review')),
    reason              TEXT,
    nonce               TEXT UNIQUE,
    valid_before        INTEGER,
    gateway_transfer_id TEXT UNIQUE,
    settlement_tx       TEXT,
    result_json         TEXT,
    approval_expires_at INTEGER,
    approved_at         INTEGER,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
  );
  CREATE INDEX purchases_day_state ON purchases(budget_day, state);
  CREATE INDEX purchases_state ON purchases(state);
  CREATE TABLE purchase_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id TEXT NOT NULL REFERENCES purchases(id),
    at          INTEGER NOT NULL,
    from_state  TEXT,
    to_state    TEXT NOT NULL,
    detail      TEXT
  );
  CREATE TABLE policy_state (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    frozen        INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0, 1)),
    frozen_reason TEXT,
    updated_at    INTEGER NOT NULL
  );
  INSERT INTO policy_state (id, frozen, updated_at) VALUES (1, 0, 0);
  `,
  // 3: onchain USDC movements reported by Quicknode Streams, and webhook delivery log
  `
  CREATE TABLE chain_movements (
    canonical_id     TEXT PRIMARY KEY,           -- chainId:txHash:logIndex (dedupes retries/replays)
    block_number     INTEGER NOT NULL,
    tx_hash          TEXT NOT NULL,
    log_index        INTEGER NOT NULL,
    from_address     TEXT NOT NULL,
    to_address       TEXT NOT NULL,
    amount_raw       TEXT NOT NULL,              -- exact integer string at raw_decimals
    raw_decimals     INTEGER NOT NULL,
    amount_usdc      INTEGER,                    -- 6-decimal base units if exactly convertible, else NULL
    classification   TEXT NOT NULL CHECK (classification IN (
                       'top_up','gateway_deposit','gateway_withdrawal','unexpected_outbound','unrelated')),
    delivery_nonce   TEXT NOT NULL,
    observed_at      INTEGER NOT NULL
  );
  CREATE INDEX chain_movements_block ON chain_movements(block_number, log_index);
  CREATE TABLE webhook_deliveries (
    nonce       TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL,
    signed_at   INTEGER NOT NULL,
    movements   INTEGER NOT NULL,
    inserted    INTEGER NOT NULL
  );
  `,
  // 4: assistant conversations (additive; nothing above changes)
  `
  CREATE TABLE chat_conversations (
    id            TEXT PRIMARY KEY,
    known_tickers TEXT NOT NULL DEFAULT '[]',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  -- Messages exactly as sent to / returned by the model (tool calls and thinking blocks included),
  -- grouped by the turn (message_id) that produced them.
  CREATE TABLE chat_messages (
    conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
    seq             INTEGER NOT NULL,
    turn_id         TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, seq)
  );
  -- One row per client message id: a repeated id returns the stored response and runs nothing again.
  CREATE TABLE chat_turns (
    message_id      TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
    kind            TEXT NOT NULL CHECK (kind IN ('user', 'event')),
    text            TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
    response        TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX chat_turns_conversation ON chat_turns(conversation_id, created_at);
  CREATE TABLE chat_purchases (
    conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
    purchase_id     TEXT NOT NULL REFERENCES purchases(id),
    turn_id         TEXT NOT NULL,
    ticker          TEXT NOT NULL,
    title           TEXT,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, purchase_id)
  );
  `,
];

export function openDatabase(path: string = process.env.DB_PATH?.trim() || DEFAULT_DB_PATH): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const current = (db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number }).v;
  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version - 1]);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, Date.now());
    }).immediate();
  }
}
