/**
 * Keeps the database inside its volume.
 *
 * The odds recorder writes about 1.6 million snapshot rows a day (~130 MB) and nothing deleted them,
 * so the 500 MB Railway volume filled on 2026-11-24 and every write failed from then on: purchases,
 * chats, approvals and the recorder itself.
 *
 * - pruneOdds: deletes odds snapshots and recorder polls older than the retention window (default
 *   48 hours), in small transactions, yielding between them so the server stays responsive. Runs
 *   shortly after startup and then every hour (startRetention).
 * - compactIfDiskLow: deleting rows frees space inside the file, not on the disk, and SQLite needs
 *   free disk for its write-ahead log on every write. So when the disk is nearly full at startup, it
 *   copies everything except expired odds into a new file in the temp directory, checks the copy,
 *   and swaps it in. Purchases, approvals, chats and the payment ledger are copied in full; nothing
 *   is swapped in unless every one of those tables has the same row count as the original.
 */
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type DB } from "./db.ts";

export const DEFAULT_RETENTION_MS = 48 * 60 * 60_000;

/** Tables pruned by age; every other table is kept in full. */
const PRUNED: Record<string, { column: string }> = {
  odds_snapshots: { column: "observed_at" },
  recorder_polls: { column: "started_at" },
};

type Log = (line: string) => void;
const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

export interface DiskSpace {
  free: number;
  total: number;
}
export const diskSpace = (dir: string): DiskSpace => {
  const s = statfsSync(dir);
  return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
};

const fileSize = (path: string) => (existsSync(path) ? statSync(path).size : 0);
const dbFilesSize = (path: string) => fileSize(path) + fileSize(`${path}-wal`);

// ---------------------------------------------------------------------------
// Startup: compact when the disk is nearly full
// ---------------------------------------------------------------------------
export interface CompactOptions {
  retentionMs?: number;
  /** Compact when free space is below this many bytes or 10% of the volume, whichever is larger. */
  minFreeBytes?: number;
  now?: () => number;
  tmpDir?: string;
  disk?: (dir: string) => DiskSpace;
  log?: Log;
}

export interface CompactResult {
  /** The database file to open: `path`, or the temp copy if the swap failed (logged loudly). */
  path: string;
  compacted: boolean;
  beforeBytes?: number;
  afterBytes?: number;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function compactIfDiskLow(path: string, o: CompactOptions = {}): CompactResult {
  const log = o.log ?? (() => {});
  if (path === ":memory:" || !existsSync(path)) return { path, compacted: false };
  const disk = (o.disk ?? diskSpace)(dirname(path));
  const before = dbFilesSize(path);
  log(`[db] ${path}: ${mb(before)}; ${mb(disk.free)} free of ${mb(disk.total)} on its volume`);
  if (disk.free >= Math.max(o.minFreeBytes ?? 50e6, disk.total * 0.1)) return { path, compacted: false };

  const cutoff = (o.now ?? Date.now)() - (o.retentionMs ?? DEFAULT_RETENTION_MS);
  log(`[db] disk nearly full: compacting, dropping odds recorded before ${new Date(cutoff).toISOString()}`);
  const tmp = join(o.tmpDir ?? tmpdir(), `allowance-compact-${process.pid}-${Date.now()}.db`);
  let src: DB | undefined;
  try {
    openDatabase(tmp).close(); // same migrations, so the same schema
    src = openDatabase(path);
    src.pragma("foreign_keys = OFF");
    src.prepare("ATTACH DATABASE ? AS fresh").run(tmp);

    const tables = (src.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'").all() as Array<{ name: string }>).map((r) => r.name);
    const columns = (schema: string, t: string) => (src!.prepare(`PRAGMA ${schema}.table_info(${quote(t)})`).all() as Array<{ name: string }>).map((c) => c.name);
    const expected = new Map<string, number>();
    src.transaction(() => {
      for (const t of tables) {
        const cols = columns("main", t);
        if (cols.join(",") !== columns("fresh", t).join(",")) throw new Error(`table ${t} differs from the current schema`);
        const list = cols.map(quote).join(", ");
        const where = PRUNED[t] ? `WHERE ${quote(PRUNED[t].column)} >= ?` : "";
        const args = PRUNED[t] ? [cutoff] : [];
        src!.exec(`DELETE FROM fresh.${quote(t)}`); // rows the migrations seed (policy_state) come from the original instead
        const copied = src!.prepare(`INSERT INTO fresh.${quote(t)} (${list}) SELECT ${list} FROM main.${quote(t)} ${where}`).run(...args).changes;
        // Kept tables: the copy must match the original's row count. Pruned tables: what the filter selected
        // (a second scan of the large odds table would only slow startup).
        expected.set(t, PRUNED[t] ? copied : (src!.prepare(`SELECT COUNT(*) AS n FROM main.${quote(t)}`).get() as { n: number }).n);
      }
      // AUTOINCREMENT counters, so ids never go backwards.
      src!.exec("DELETE FROM fresh.sqlite_sequence; INSERT INTO fresh.sqlite_sequence (name, seq) SELECT name, seq FROM main.sqlite_sequence");
    })();

    // Check the copy before touching the original.
    for (const [t, n] of expected) {
      const got = (src.prepare(`SELECT COUNT(*) AS n FROM fresh.${quote(t)}`).get() as { n: number }).n;
      if (got !== n) throw new Error(`copy of ${t} has ${got} rows, expected ${n}`);
    }
    const integrity = (src.prepare("PRAGMA fresh.integrity_check").get() as { integrity_check: string }).integrity_check;
    if (integrity !== "ok") throw new Error(`copy failed integrity_check: ${integrity}`);
    if (src.prepare("PRAGMA fresh.foreign_key_check").all().length) throw new Error("copy has foreign key violations");
    src.exec("DETACH DATABASE fresh");
    src.close();
    src = undefined;
    const fresh = openDatabase(tmp);
    fresh.pragma("wal_checkpoint(TRUNCATE)");
    fresh.close(); // the copy is now one self-contained file
  } catch (err) {
    try {
      src?.close();
    } catch {}
    rmSync(tmp, { force: true });
    rmSync(`${tmp}-wal`, { force: true });
    rmSync(`${tmp}-shm`, { force: true });
    log(`[db] compaction skipped, original left as it was: ${(err as Error).message}`);
    return { path, compacted: false };
  }

  // Swap. Copy next to the original first when there is room; otherwise the original has to go first.
  const after = fileSize(tmp);
  const staged = `${path}.compact`;
  const removeOriginal = () => {
    for (const f of [`${path}-wal`, `${path}-shm`, path]) rmSync(f, { force: true });
  };
  try {
    const room = (o.disk ?? diskSpace)(dirname(path)).free > after + 10e6;
    if (!room) removeOriginal();
    copyFileSync(tmp, staged);
    const fd = openSync(staged, "r+");
    fsyncSync(fd);
    closeSync(fd);
    if (room) removeOriginal();
    renameSync(staged, path);
    rmSync(tmp, { force: true });
  } catch (err) {
    rmSync(staged, { force: true });
    if (existsSync(path)) {
      log(`[db] compaction swap failed, original kept: ${(err as Error).message}`);
      rmSync(tmp, { force: true });
      return { path, compacted: false };
    }
    log(`[db] COMPACTION SWAP FAILED (${(err as Error).message}); running from the temp copy ${tmp}. Restarting now would lose data: copy it back to ${path} first.`);
    return { path: tmp, compacted: true, beforeBytes: before, afterBytes: after };
  }
  log(`[db] compacted ${mb(before)} -> ${mb(after)}; ${mb((o.disk ?? diskSpace)(dirname(path)).free)} free`);
  return { path, compacted: true, beforeBytes: before, afterBytes: after };
}

// ---------------------------------------------------------------------------
// Ongoing: prune expired odds in small transactions
// ---------------------------------------------------------------------------
export interface PruneOptions {
  retentionMs?: number;
  now?: () => number;
  /** Instruments per transaction. */
  batch?: number;
  log?: Log;
}

const yieldToServer = () => new Promise<void>((r) => setImmediate(r));

/** Deletes odds snapshots, then recorder polls, older than the retention window. */
export async function pruneOdds(db: DB, o: PruneOptions = {}): Promise<{ snapshots: number; polls: number }> {
  const cutoff = (o.now ?? Date.now)() - (o.retentionMs ?? DEFAULT_RETENTION_MS);
  const batch = o.batch ?? 200;
  const symbols = (db.prepare("SELECT instrument_symbol AS s FROM gemini_contracts").all() as Array<{ s: string }>).map((r) => r.s);
  // The primary key is (instrument_symbol, observed_at), so each delete is one contiguous range.
  const del = db.prepare("DELETE FROM odds_snapshots WHERE instrument_symbol = ? AND observed_at < ?");
  const run = db.transaction((group: string[]) => group.reduce((n, s) => n + del.run(s, cutoff).changes, 0));
  let snapshots = 0;
  for (let i = 0; i < symbols.length; i += batch) {
    snapshots += run.immediate(symbols.slice(i, i + batch));
    await yieldToServer();
  }
  // A snapshot's observed_at is its poll's started_at, so no remaining snapshot points at these polls.
  const polls = db.prepare("DELETE FROM recorder_polls WHERE started_at < ?").run(cutoff).changes;
  if (snapshots || polls) db.pragma("wal_checkpoint(PASSIVE)");
  o.log?.(`[retention] removed ${snapshots} odds rows and ${polls} recorder polls from before ${new Date(cutoff).toISOString()}`);
  return { snapshots, polls };
}

/** Prunes shortly after startup, then every `intervalMs`. One run at a time; errors are logged, never thrown. */
export function startRetention(db: DB, o: PruneOptions & { intervalMs?: number; firstRunMs?: number } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pruneOdds(db, o);
    } catch (err) {
      o.log?.(`[retention] prune failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, o.firstRunMs ?? 10_000);
  const every = setInterval(tick, o.intervalMs ?? 60 * 60_000);
  first.unref();
  every.unref();
  return {
    stop() {
      clearTimeout(first);
      clearInterval(every);
    },
  };
}
