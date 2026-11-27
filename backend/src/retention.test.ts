/**
 * Disk-full recovery and odds retention (src/retention.ts). The data is made by the real recorder and
 * ledger, so snapshots, polls, purchases and their foreign keys look like production.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARC_TESTNET } from "./config.ts";
import { openDatabase, type DB } from "./db.ts";
import { createLedger } from "./ledger.ts";
import type { PolicyConfig } from "./policy.ts";
import { createRecorder } from "./recorder.ts";
import { compactIfDiskLow, pruneOdds } from "./retention.ts";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 10, 26, 17, 0, 0);
const RETENTION = 48 * HOUR;
const SELLER = "0x3b53b70d0275e5b2f8a3DFe6Cb0d949B3D7Ea14e";
const FULL = () => ({ free: 4e6, total: 500e6 }); // the production volume on 2026-11-26
const ROOMY = () => ({ free: 400e6, total: 500e6 });

/** Fills `db` like production: polls every 30 min from 72 h to 42.5 h ago (straddling the 48 h cutoff), then 2 recent polls. */
async function fill(db: DB) {
  let clock = NOW - 72 * HOUR;
  let tick = 0;
  const recorder = createRecorder(db, {
    now: () => clock,
    pageDelayMs: 0,
    log: () => {},
    fetchPage: async (offset, limit) => ({
      data: offset
        ? []
        : Array.from({ length: 20 }, (_, e) => ({
            id: String(e), ticker: `EVT-${e}`, title: `Event ${e}`, category: "Sports",
            contracts: Array.from({ length: 5 }, (_, c) => ({
              id: `${e}-${c}`, label: `Outcome ${c}`, instrumentSymbol: `GEMI-EVT-${e}-${c}`,
              prices: { bestBid: (0.1 + ((tick + c) % 50) / 100).toFixed(2), bestAsk: "0.99" }, // changes every poll
            })),
          })),
      pagination: { limit, offset, total: 20 },
    }),
  });
  for (let i = 0; i < 60; i++, tick++, clock += 30 * 60_000) await recorder.pollOnce(); // 30 h of old data
  clock = NOW - 2 * HOUR;
  for (let i = 0; i < 2; i++, tick++, clock += HOUR) await recorder.pollOnce(); // recent data

  const policy: PolicyConfig = {
    network: ARC_TESTNET.network, asset: ARC_TESTNET.usdc.address, decimals: 6, allowedPayees: [SELLER],
    autoApproveMax: 250_000n, perCallMax: 1_000_000n, dailyCap: 5_000_000n, timeZone: "America/Chicago",
  };
  const ledger = createLedger(db, policy, { now: () => NOW - 60 * HOUR });
  const quote = { payTo: SELLER, network: policy.network, asset: policy.asset, amount: 750_000n };
  const p = ledger.reserve({ idempotencyKey: "key-old-purchase", itemId: "deep_brief", sellerId: "odds-desk", resourceUrl: "http://x/y", quote, gatewayAvailable: 5_000_000n }).purchase;
  ledger.decline(p.id);
  ledger.setFrozen(true, "Frozen in a test");
  db.prepare("INSERT INTO chat_conversations (id, known_tickers, created_at, updated_at) VALUES ('conv-aaaaaaaa', '[\"EVT-1\"]', 1, 1)").run();
  db.prepare("INSERT INTO chat_turns (message_id, conversation_id, kind, text, status, created_at, updated_at) VALUES ('msg-aaaaaaaa', 'conv-aaaaaaaa', 'user', 'BTC odds?', 'done', 1, 1)").run();
  db.prepare("INSERT INTO chat_messages (conversation_id, seq, turn_id, role, content, created_at) VALUES ('conv-aaaaaaaa', 1, 'msg-aaaaaaaa', 'user', '[]', 1)").run();
  db.prepare("INSERT INTO chat_purchases (conversation_id, purchase_id, turn_id, ticker, title, created_at) VALUES ('conv-aaaaaaaa', ?, 'msg-aaaaaaaa', 'EVT-1', 'Event 1', 1)").run(p.id);
  db.prepare("INSERT INTO webhook_deliveries (nonce, received_at, signed_at, movements, inserted) VALUES ('n1', 1, 1, 0, 0)").run();
  return { purchaseId: p.id };
}

const KEPT = ["gemini_events", "gemini_contracts", "purchases", "purchase_events", "policy_state", "chain_movements", "webhook_deliveries", "chat_conversations", "chat_messages", "chat_turns", "chat_purchases"];
const count = (db: DB, t: string, where = "", ...args: unknown[]) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} ${where}`).get(...args) as { n: number }).n;
const snapshot = (db: DB) => Object.fromEntries(KEPT.map((t) => [t, count(db, t)]));
const seq = (db: DB) => Object.fromEntries((db.prepare("SELECT name, seq FROM sqlite_sequence").all() as Array<{ name: string; seq: number }>).map((r) => [r.name, r.seq]));

async function prodLikeFile() {
  const dir = mkdtempSync(join(tmpdir(), "allowance-retention-"));
  const path = join(dir, "allowance.db");
  const db = openDatabase(path);
  const ids = await fill(db);
  const before = {
    kept: snapshot(db),
    seq: seq(db),
    recentSnapshots: count(db, "odds_snapshots", "WHERE observed_at >= ?", NOW - RETENTION),
    recentPolls: count(db, "recorder_polls", "WHERE started_at >= ?", NOW - RETENTION),
    polls: count(db, "recorder_polls"),
  };
  db.close();
  return { dir, path, ids, before };
}

test("disk nearly full: compaction drops expired odds, keeps every purchase, chat and ledger row, and shrinks the file", async () => {
  const { dir, path, ids, before } = await prodLikeFile();
  const sizeBefore = statSync(path).size;
  const lines: string[] = [];
  const r = compactIfDiskLow(path, { retentionMs: RETENTION, now: () => NOW, tmpDir: dir, disk: FULL, log: (l) => lines.push(l) });
  assert.equal(r.compacted, true, lines.join("\n"));
  assert.equal(r.path, path, "swapped into place, not running from the temp copy");
  assert.ok(statSync(path).size < sizeBefore, `file shrank: ${sizeBefore} -> ${statSync(path).size}`);

  const db = openDatabase(path);
  assert.deepEqual(snapshot(db), before.kept, "every non-odds table copied in full");
  assert.equal(count(db, "odds_snapshots", "WHERE observed_at < ?", NOW - RETENTION), 0, "no expired odds left");
  assert.equal(count(db, "odds_snapshots"), before.recentSnapshots, "recent odds kept");
  assert.equal(count(db, "recorder_polls"), before.recentPolls, "only polls inside the window kept");
  assert.ok(before.recentPolls < before.polls && before.recentSnapshots > 0, "the test data straddles the cutoff");
  assert.deepEqual(seq(db), before.seq, "AUTOINCREMENT counters kept, so ids never repeat");
  assert.equal((db.prepare("SELECT frozen FROM policy_state").get() as { frozen: number }).frozen, 1, "the freeze switch survives");
  assert.equal((db.prepare("SELECT state FROM purchases WHERE id = ?").get(ids.purchaseId) as { state: string }).state, "declined");
  assert.equal((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  // And it is writable again.
  db.prepare("INSERT INTO webhook_deliveries (nonce, received_at, signed_at, movements, inserted) VALUES ('n2', 2, 2, 0, 0)").run();
  db.close();
  assert.ok(!existsSync(`${path}.compact`), "no staging file left behind");
});

test("with room on the disk, the copy is staged next to the original before the original is removed", async () => {
  const { dir, path, before } = await prodLikeFile();
  let calls = 0;
  const disk = () => (calls++ === 0 ? FULL() : ROOMY()); // full at the check, room at the swap
  const r = compactIfDiskLow(path, { retentionMs: RETENTION, now: () => NOW, tmpDir: dir, disk });
  assert.equal(r.compacted, true);
  const db = openDatabase(path);
  assert.deepEqual(snapshot(db), before.kept);
  db.close();
});

test("enough free disk: nothing is touched", async () => {
  const { dir, path, before } = await prodLikeFile();
  const size = statSync(path).size;
  const r = compactIfDiskLow(path, { retentionMs: RETENTION, now: () => NOW, tmpDir: dir, disk: ROOMY });
  assert.equal(r.compacted, false);
  assert.equal(statSync(path).size, size);
  const db = openDatabase(path);
  assert.equal(count(db, "recorder_polls"), before.polls);
  db.close();
});

test("if the copy can't be made faithfully, the original is left exactly as it was", async () => {
  const { dir, path, before } = await prodLikeFile();
  const db = openDatabase(path);
  db.exec("ALTER TABLE purchases ADD COLUMN surprise TEXT"); // schema the copy doesn't know
  db.close();
  const lines: string[] = [];
  const r = compactIfDiskLow(path, { retentionMs: RETENTION, now: () => NOW, tmpDir: dir, disk: FULL, log: (l) => lines.push(l) });
  assert.equal(r.compacted, false);
  assert.match(lines.join("\n"), /compaction skipped, original left as it was/);
  const after = openDatabase(path);
  assert.deepEqual(snapshot(after), before.kept);
  assert.equal(count(after, "recorder_polls"), before.polls, "nothing pruned either");
  after.close();
});

test("hourly pruning removes only expired odds and polls, and keeps foreign keys valid", async () => {
  const db = openDatabase(":memory:");
  await fill(db);
  const recent = count(db, "odds_snapshots", "WHERE observed_at >= ?", NOW - RETENTION);
  const expired = count(db, "odds_snapshots") - recent;
  const recentPolls = count(db, "recorder_polls", "WHERE started_at >= ?", NOW - RETENTION);
  const expiredPolls = count(db, "recorder_polls") - recentPolls;
  assert.ok(expired > 0 && recent > 0 && expiredPolls > 0, "the test data straddles the cutoff");
  const kept = snapshot(db);
  const r = await pruneOdds(db, { retentionMs: RETENTION, now: () => NOW, batch: 7 });
  assert.equal(r.snapshots, expired);
  assert.equal(r.polls, expiredPolls);
  assert.equal(count(db, "odds_snapshots"), recent);
  assert.equal(count(db, "recorder_polls"), recentPolls);
  assert.deepEqual(snapshot(db), kept, "purchases, chats and the ledger are never pruned");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(await pruneOdds(db, { retentionMs: RETENTION, now: () => NOW }), { snapshots: 0, polls: 0 }, "a second run finds nothing");
});
