# API response fixtures

Captured 2026-11-20 at 12:16 UTC for the frontend. Later captures:
- the live deep brief at 13:04 UTC;
- `catalog.json`, `purchases-list.json` and `purchase-settled-odds_snapshot.json`, re-captured after deploy `315e6c55` (13:11 UTC).

Percentages show at most one decimal and are never normalized to 100%; see [FRONTEND_HANDOFF §3](../FRONTEND_HANDOFF.md). The two deep-brief files predate that format and say so in `_provenance.percentFormat`. The contract and usage guide are in [../FRONTEND_HANDOFF.md](../FRONTEND_HANDOFF.md).

Each file is `{ "_provenance": {...}, "request": {...}, "response": { "status", "headers", "body" } }`. Multi-example files use `examples: [...]` instead. To use a fixture as a mock, take `response.body`.

| `_provenance.source` | Meaning |
|---|---|
| `live` | Captured from `https://allowance-backend-production.up.railway.app`. Only GET requests, plus POSTs the API rejects at validation (no session, quote or payment was created). The purchases these read were made separately, before capture. |
| `local-dev` | Real testnet purchases made earlier that day by the local service, read through the same API code. |
| `shape` | The real API code run on an in-memory database with throwaway credentials, for states with no live example. The quote or upstream is stubbed. |

| File | Source | Shows |
|---|---|---|
| `health.json` | live | `GET /health` |
| `catalog.json` | live | Catalog items, prices, sellers |
| `markets-search.json` | live | Market search (trimmed to 2 events × 4 contracts) |
| `purchases-list.json` | live | Ledger list |
| `purchase-settled-odds_snapshot.json` | live | Paid and settled purchase with `summary` and `result` |
| `purchase-declined-deep_brief.json` | live | Declined by the operator; nothing signed |
| `budget.json` | live | Budget meter and freeze state |
| `chain-movements.json` | live | Real Quicknode-delivered `gateway_deposit` of 0.5 USDC |
| `voice-session-not-configured.json` | live | 503 `voice_not_configured` (current live state) |
| `errors-live.json` | live | 400/401/403/404/415 examples and CORS preflights |
| `purchase-settled-odds_history.json` | local-dev | History result for charting (points trimmed) |
| `purchase-settled-deep_brief.json` | live | Paid, operator-approved and settled $0.75 brief bought on Railway at 12:48 UTC: real analytics (`mock: false`, `status: ok`, flat market), `settlementTx` set. Not trimmed. |
| `deep-brief-results.json` | local-dev | New brief on real recorded data, three cases: steady (`ok`, no change), moving (`ok`, biggest move +6 points), newly listed (`insufficient_history`). Computed locally with the same code that is deployed and live-verified. |
| `purchase-blocked-full_report.json` | local-dev | Blocked: seller not allowlisted |
| `purchase-blocked-frozen.json` | local-dev | Blocked: spending frozen |
| `purchase-blocked-insufficient_funds.json` | local-dev | Blocked: not enough Gateway funds |
| `chain-movements-all-classes.json` | local-dev | `top_up`, `gateway_deposit`, plus one **SYNTHETIC** `unexpected_outbound` row (labeled) |
| `errors-local.json` | local-dev | 409 `invalid_state` |
| `purchase-awaiting_approval-deep_brief.json` | shape | Held for approval (`nonce: null`) |
| `sessions.json` | shape | Agent and operator session responses (tokens and codes **redacted**) |
| `voice-session-ok.example.json` | shape | **UNVERIFIED** ElevenLabs success shape (stubbed upstream; tokens redacted) |
| `operator-actions.json` | shape | Freeze, unfreeze, approve (stub buyer: stops at `reserved`), decline |

**Never committed here:** `.env` contents, private keys, the static API tokens, access codes, live session tokens and ElevenLabs credentials. A scan against every secret value found none.
