/**
 * Runs the Gemini odds recorder on its own (until the full service owns it).
 *   npm run recorder
 * Writes to DB_PATH (default backend/data/allowance.db). Needs no secrets.
 */
import { openDatabase, DEFAULT_DB_PATH } from "../src/db.ts";
import { createRecorder } from "../src/recorder.ts";

const db = openDatabase();
const recorder = createRecorder(db);
console.log(`[recorder] writing to ${process.env.DB_PATH?.trim() || DEFAULT_DB_PATH}; polling every 60 s`);
recorder.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    recorder.stop();
    db.close();
    console.log(`[recorder] stopped (${signal})`);
    process.exit(0);
  });
}
