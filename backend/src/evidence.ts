/**
 * Append-only JSONL run logs under backend/.smoke/ (gitignored).
 * Holds public data only: addresses, nonces, transfer ids, tx hashes. Never keys or signatures.
 */
import { appendFileSync, mkdirSync } from "node:fs";

const dir = new URL("../.smoke/", import.meta.url);

export function appendEvidence(file: string, record: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...record }, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  appendFileSync(new URL(file, dir), `${line}\n`, { mode: 0o600 });
}
