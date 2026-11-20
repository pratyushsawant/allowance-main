// Mock mode runs the whole UI on fake data with no backend: start with `VITE_USE_MOCK=1 npm run dev`.
export const USE_MOCK = import.meta.env.VITE_USE_MOCK === "1";

// Allowance backend (Railway). Override with VITE_API_URL, e.g. for a local backend on :8787.
// This is a public URL; no secret ever goes in the frontend. People type access codes at runtime.
export const API_URL = (import.meta.env.VITE_API_URL || "https://allowance-backend-production.up.railway.app").replace(/\/$/, "");

// Arc Testnet explorer, the same one the backend links to (viem's arcTestnet chain definition).
export const EXPLORER_TX_URL = (hash: string) => `https://explorer.testnet.arc.io/tx/${hash}`;
