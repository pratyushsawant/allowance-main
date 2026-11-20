# Allowance backend: frontend handoff

As of 2026-11-20, 12:16 UTC. For the frontend teammate. The backend is live and was verified end to end on Arc Testnet. This doc is the contract: what to call, with which credential, how often, and what each answer means. Real response bodies are in [api-examples/](api-examples/README.md). Voice-agent specifics, like tool definitions and agent instructions, are in [VOICE_INTEGRATION.md](VOICE_INTEGRATION.md).

Labels used below: **LIVE** (verified against the deployed service), **MOCK** (placeholder content), **UNVERIFIED** (built and unit-tested, never exercised against the real third party).

## 1. Base URL and environment

| | |
|---|---|
| Base URL | **`https://allowance-backend-production.up.railway.app`** (LIVE) |
| Local dev | `http://127.0.0.1:8787` after `npm start` in `backend/`. Only one instance may spend with the shared test wallet, so ask before running it. |
| Network | Arc **Testnet**. All money is testnet USDC. |
| CORS | Allowed origins are currently `http://localhost:3000` and `http://localhost:5173`. **Send the backend owner your deployed origin** (for example `https://allowance.vercel.app`) and it will be added. Requests from other origins fail the preflight (403). |
| Transport | JSON over HTTPS. Credentials go in `Authorization: Bearer <token>`; no cookies. |

### Two repositories, deployed independently

The frontend lives in its own repository and deployment and talks to the backend only over HTTPS at the base URL above. No backend code or secrets are needed in the frontend repo; [api-examples/](api-examples/README.md) can be copied in as mocks.

**To get CORS enabled, send the backend owner your exact origins:**
- scheme + host + port, no path, no trailing slash, e.g. `https://allowance-ui.vercel.app` and `http://localhost:5173`;
- wildcards aren't supported;
- preview deployments that change URL on every push won't work, so give a stable production or preview domain.

Until your origin is added, browser calls from it fail the preflight with 403 `origin_not_allowed`. Server-side calls and curl aren't affected.

Before submission, both codebases get consolidated into one repository (`/frontend`, `/backend`) with a root README. Keep your repository free of secrets and build output so that move is clean.

## 2. Authentication and roles

There are two roles. The frontend **never** holds a static backend credential; it gets short-lived session tokens by sending an access code that a person types.

| Role | Can do | Session lifetime | How to get one |
|---|---|---|---|
| **agent** | Search markets, read the catalog, request purchases, read purchases, budget and chain movements, start a voice session | 2 h | `POST /api/sessions` `{"scope":"agent","accessCode":"<DEMO_ACCESS_CODE>"}` |
| **operator** | Everything an agent can, **plus** approve or decline held purchases and freeze or unfreeze spending | 1 h | `POST /api/sessions` `{"scope":"operator","accessCode":"<OPERATOR_ACCESS_CODE>"}` |

The response is `{ "token": "as1.…", "scope": "agent", "expiresAt": 1795184170000 }`; `expiresAt` is in milliseconds. See [api-examples/sessions.json](api-examples/sessions.json), which has tokens redacted. Treat the token as opaque.

**Rules (please follow exactly):**
1. **Access codes are typed by a person at runtime.** Never put them in source, env files, builds, URLs, logs or analytics. The owner shares them through a password manager, not chat.
2. **Use the agent token, and only it, in voice tool handlers.** The ElevenLabs agent calls your client tools. Those handlers must only ever see the agent token.
3. **Keep the operator token apart.** Store it in a separate module that the client tools can't reach. Ask for the operator code only when a person taps **Approve**, **Decline**, **Freeze** or **Unfreeze**.
4. **Keep tokens in memory only, not `localStorage`.** On reload, ask for the code again.
5. **On a 401, drop the token** and ask the person for the code again. There's no refresh endpoint.
6. **Failed logins are limited** to 10 per 10 minutes per client address; after that the API answers 429 `too_many_attempts`.
7. **An agent credential can never approve, decline or unfreeze.** The server enforces this (LIVE: an agent token on approve got 401). The UI must not offer those actions to the voice agent either.
8. **Ignore the static `AGENT_API_TOKEN` and `OPERATOR_API_TOKEN`.** They're for backend scripts. Never use them in the frontend.

## 3. Endpoints

All bodies are JSON. Amounts arrive in two forms: `amount`-style fields are **strings of USDC base units** (6 decimals, so `"750000"` = $0.75), and `*Usdc` fields are **decimal strings** (`"0.75"`). Timestamps are **milliseconds since epoch**.

| Method and path | Role | Purpose | Example |
|---|---|---|---|
| `GET /health` | none | Liveness: `{"ok":true}` | [health.json](api-examples/health.json) |
| `POST /api/sessions` | none | Exchange an access code for a session token | [sessions.json](api-examples/sessions.json) |
| `POST /api/voice/session` `{transport?: "webrtc"\|"websocket"}` | agent | ElevenLabs credentials for `startSession` | [ok](api-examples/voice-session-ok.example.json) (UNVERIFIED) · [503 now](api-examples/voice-session-not-configured.json) |
| `GET /api/catalog` | agent | Items, prices, sellers | [catalog.json](api-examples/catalog.json) |
| `GET /api/markets/search?q=` (2–80 chars) | agent | Free search over recorded events with latest prices (up to 8) | [markets-search.json](api-examples/markets-search.json) |
| `POST /api/purchases` `{item, ticker, idempotencyKey}` | agent | Request a purchase. Returns the purchase view (section 4). | [awaiting](api-examples/purchase-awaiting_approval-deep_brief.json) · [blocked](api-examples/purchase-blocked-full_report.json) |
| `GET /api/purchases?limit=20` | agent | Recent purchases, newest first (max 100). This is the ledger. | [purchases-list.json](api-examples/purchases-list.json) |
| `GET /api/purchases/:id` | agent | One purchase (the agent's `get_purchase`) | [settled snapshot](api-examples/purchase-settled-odds_snapshot.json) |
| `GET /api/budget` | agent | Daily cap, committed, remaining, Gateway funds, frozen state | [budget.json](api-examples/budget.json) |
| `GET /api/chain/movements?limit=20` | agent | Onchain USDC movements of the agent wallet (from Quicknode Streams) | [live](api-examples/chain-movements.json) · [all classes](api-examples/chain-movements-all-classes.json) |
| `POST /api/purchases/:id/approve` | **operator** | Approve a held purchase. The server re-runs the full policy, then pays. | [operator-actions.json](api-examples/operator-actions.json) |
| `POST /api/purchases/:id/decline` | **operator** | Decline a held purchase | same |
| `POST /api/policy/freeze` `{reason?}` | **operator** | Stop all spending | same |
| `POST /api/policy/unfreeze` | **operator** | Resume spending | same |

Not for the frontend: `/sellers/*` (internal x402 sellers the backend buys from) and `/webhooks/quicknode` (signed Quicknode deliveries only).

### `POST /api/purchases` details

- `item`: one of `odds_snapshot` ($0.005), `odds_history` ($0.02), `deep_brief` ($0.75), `full_report` ($0.01, from a seller that is **not** allowlisted, so it is always blocked).
- `ticker`: an event ticker from `/api/markets/search`, e.g. `NCAAM-2611201730-MINN-OKST-M`.
- `idempotencyKey`: 8–128 chars of `[A-Za-z0-9._:-]`. **Generate one new key (`crypto.randomUUID()`) per user or agent action, and reuse it on retries of that same action.** Repeating a key returns the original purchase and never pays twice (LIVE).
- The call returns once the purchase reaches its first resting state. Paid purchases usually come back `accepted` in about 1 s.

### Purchase view (every purchase endpoint returns this)

| Field | Meaning |
|---|---|
| `id` | Purchase id (UUID) |
| `item`, `seller` | Catalog item and seller id |
| `state` | See section 4 |
| `priceUsdc`, `amount` | `"0.75"` and `"750000"` (base units) |
| `reason` | Human-readable policy or outcome reason. Show it. |
| `next` | Instruction for the voice agent (e.g. "Tell the person the price and ask them to approve…") |
| `summary` | One spoken sentence once paid, e.g. "Minnesota vs Oklahoma State: Minnesota about 51.5%, Oklahoma State about 48.5%…". Otherwise `null`. |
| `result` | The purchased data, only when `accepted` or `settled` |
| `payTo`, `nonce`, `gatewayTransferId`, `settlementTx` | Payment evidence. `nonce` is `null` until something is signed; `settlementTx` appears when settled onchain. |
| `approvalExpiresAt` | For held purchases: when the 10-minute approval window ends (ms) |
| `createdAt`, `updatedAt` | ms |

### `result` shapes (for rendering)

- **`odds_snapshot`**:
  - `event{ticker,title,category,contracts[{label,bestBid,bestAsk,lastTradePrice,observedAt}]}`;
  - `related{item:"full_report",…}`, which is the upsell the agent should **not** follow.
- **`odds_history`**:
  - `recordedSince` / `recordedUntil` (ms);
  - `contracts[{label, points[{at,bestBid,bestAsk,lastTradePrice}], bidChange}]`;
  - `biggestMovers[{label,bidChange}]`.

  **Chart these points.** Prices are decimal strings (USD per contract = implied probability), and `points` only contains a row when a price changed (plus a 15-minute heartbeat), so draw it as a **step chart**. Quiet events may show one point per contract.
- **`deep_brief`**: analytics computed **only from recorded prices**. **LIVE:** deployed 2026-11-20 12:34 UTC and bought live at 12:48 UTC ([purchase-settled-deep_brief.json](api-examples/purchase-settled-deep_brief.json)). Briefs bought before the deploy keep their old placeholder result (`mock: true`); none is on the live ledger. Paid briefs return this shape, which keeps every old field:
  - top level: `{ mock: false, note, generatedAt, method, coverage, event, analysis, relatedMarkets[], relatedAnalysis[] }`;
  - `analysis`:
    - `status` (`"ok"` | `"insufficient_history"`)
    - `leader{label, impliedProbability}`
    - `probabilitiesSum`
    - `widestSpread`
    - `biggestMove{label, changePoints, since}` or `null`
    - `notes[]`, e.g. recorder gaps or failed polls
    - `contracts[]`, each with `current{mid, impliedProbability, spread, …}` and `history{status, observations, windowMinutes, reason, firstMid, change, changePoints, high, low}`.

  Movement fields are **`null`** unless a contract has 2+ observations spanning 15+ minutes, and then `reason` says why. **Show `reason`/`notes` rather than a chart when `status` is `insufficient_history`.** Related markets are the same Gemini category by 24 h volume; the category is broad (e.g. "Sports"), so treat them as context, not as linked markets.

  **Percentages** (`impliedProbability`, `leader.impliedProbability`, `probabilitiesSum`, and the percentages in `summary`):
  - They're strings like `"51.5%"`, with at most one decimal. That's exact for cent prices and their midpoints (0.515 → `"51.5%"`).
  - Each value is formatted on its own and is **never adjusted to add up to 100%**. A market's prices can sum above or below 1 (spread, overround), and `probabilitiesSum` shows that as it is, e.g. `"102%"`.
  - For a **total**, display `probabilitiesSum`. Never add the per-contract strings.
  - For math, use `mid` (a decimal price string), not the percentage.
  - **Format change (deploy `315e6c55`, 13:11 UTC):** before it, values were whole numbers (0.515 → `"52%"`, 0.485 → `"49%"`). Results already stored keep the format they were delivered with. The one live brief (`7ddb7cf0…`) and its summary still say "52%". Parse with `parseFloat`, not `parseInt`. The live purchase is in [purchase-settled-deep_brief.json](api-examples/purchase-settled-deep_brief.json) (flat market, `status: ok`). [deep-brief-results.json](api-examples/deep-brief-results.json) adds a moving event and an `insufficient_history` case.
- **`full_report`**: **MOCK** placeholder. It's never purchasable under the current policy.

## 4. Purchase states and what the UI should do

| `state` | Meaning | UI |
|---|---|---|
| `accepted` | Paid. Gateway accepted the payment; onchain batch settlement follows, observed at 6–13 min. | Show as **paid** in the ledger; use `summary`/`result` |
| `settled` | Paid and settled onchain (`settlementTx` set) | Show **settled** with an explorer link `https://explorer.testnet.arc.io/tx/<settlementTx>` |
| `awaiting_approval` | Over the $0.25 auto-approve limit; nothing signed or held yet | **Approval card**: item, price, `reason`, countdown to `approvalExpiresAt`, Approve and Decline (operator) |
| `blocked` | Policy said no: unlisted seller, a cap, frozen, or insufficient funds | Show `reason`. The agent says why and doesn't retry. |
| `declined`, `approval_expired` | A person declined, or nobody answered in time | Show; nothing paid |
| `reserved`, `signed` | In progress (seconds) | Spinner |
| `pending_unknown` | Payment sent; outcome being confirmed with Circle | "Confirming payment…". Never show as failed; funds stay held. |
| `rejected`, `aborted`, `expired` | Not paid; any held funds released | Show `reason` |
| `needs_review` | Circle reported a failure after acceptance; funds held | Show a warning |

The `next` field already tells the voice agent what to do for each state.

## 5. Polling

There's no live push from the server; poll at these rates.

| Data | Endpoint | Interval |
|---|---|---|
| Ledger | `GET /api/purchases?limit=20` | **3 s** while any visible purchase is `awaiting_approval`, `reserved`, `signed` or `pending_unknown`; otherwise **10 s**. Refetch immediately after a buy, approve or decline. |
| Approval card | `GET /api/purchases/:id` | **3 s** while it's open. Close it when the state leaves `awaiting_approval` or at `approvalExpiresAt`. |
| Budget meter and freeze banner | `GET /api/budget` | **5 s**, plus right after any purchase or operator action. If `frozen` turns `true` without the person freezing it, the Streams monitor detected an unexpected transfer. Show `frozenReason` and have the agent announce it (`sendContextualUpdate`). |
| Onchain feed | `GET /api/chain/movements?limit=20` | **5 s**. Quicknode delivers within seconds of the block (LIVE). |
| `accepted` → `settled` | (comes through the ledger poll) | Observed at **6–13 minutes** (the live $0.75 brief took 12 min 54 s). The server checks every 30 s. Don't block on it. |
| Market search, catalog | on demand | No polling |
| Voice session | `POST /api/voice/session` | Once per conversation start. Don't cache. |

**Back-off:** on network errors, 429 or 5xx, retry at 1 s, 2 s, 4 s, … up to 30 s. On 401, ask for the access code again. Keep each browser tab under about 2 requests per second.

## 6. Error codes

Errors are `{"error": "<code>", "message": "<text>"}`. Examples are in [errors-live.json](api-examples/errors-live.json) (LIVE) and [errors-local.json](api-examples/errors-local.json).

| HTTP | `error` | When | UI action |
|---|---|---|---|
| 400 | `invalid_json`, `unknown_item`, `invalid_ticker`, `invalid_idempotency_key`, `invalid_query`, `invalid_scope` | Bad input | Fix the request; don't retry as is |
| 401 | `unauthorized` | Missing, expired or wrong-role token | Ask for the code again (an operator code for operator actions) |
| 401 | `invalid_access_code` | Wrong code at login | Show "wrong code" |
| 403 | `origin_not_allowed` (preflight) | Your origin isn't on the CORS list | Ask the backend owner to add it |
| 404 | `not_found` | Unknown purchase or route | — |
| 404 | `unknown_event` | Ticker not in the recorder | Search again |
| 409 | `invalid_state`, `conflict` | E.g. approving something no longer awaiting approval, or a double click | Refetch the purchase |
| 413 / 415 | `body_too_large` / `unsupported_media_type` | Body over 16 KB, or not `application/json` | Fix the request |
| 429 | `too_many_attempts` | 10 failed logins in 10 minutes | Wait, then retry |
| 500 | `internal_error` | Unexpected | Back off and retry; report it |
| 502 | `seller_unavailable` | The data seller didn't answer with a valid offer | Retry later with the **same** idempotency key |
| 502 | `voice_upstream_error` | ElevenLabs refused or failed | Retry; fall back to text mode |
| 503 | `voice_not_configured` | ElevenLabs credentials not set on the server (**current live state**) | Show "voice unavailable"; offer text input |

## 7. Demo flow → API calls

This follows the brief's video script. Each full run commits **$0.775** of the **$2.00 daily cap**, which resets at midnight America/Chicago, so plan rehearsals accordingly. Raising the cap is the backend owner's decision.

| # | Moment | Calls |
|---|---|---|
| 0 | Start | Login as agent → `POST /api/voice/session` → ElevenLabs `startSession({conversationToken, clientTools})`. *Voice is UNVERIFIED and currently 503, so use text mode until it's configured.* |
| 1 | Auto-pay | Agent: `search_markets` → `buy odds_snapshot` → `accepted`. Agent reads `summary`; the ledger and budget refresh. |
| 2 | Analytics | `buy odds_history` → `accepted`. Render a **step chart** from `result.contracts[].points`, plus `biggestMovers`. |
| 3 | Approval | `buy deep_brief` → `awaiting_approval`. The approval card shows. The person taps Approve → operator code (if no operator session) → `POST …/approve` → `accepted`. Then `conversation.sendUserMessage("I approved purchase <id>.")`, and the agent calls `get_purchase` and reads `summary`, e.g. "Minnesota vs Oklahoma State: Minnesota leads at about 51.5%; no change since 4:44 AM. Related: …". *LIVE: this exact loop ran on Railway at 12:48 UTC (operator approve → `accepted`; `settled` at 13:01). That brief predates the percent-format change and says "about 52%".* |
| 4 | Block | The snapshot's `result.related` suggests `full_report`. If the agent tries it → `blocked` ("Seller … is not on the allowlist"), and the agent explains why. |
| 5 | Onchain proof | A Gateway deposit or top-up of the agent wallet shows up in `/api/chain/movements` within seconds (LIVE: `gateway_deposit 0.5`). Gateway funds in `/api/budget` rise after a deposit. |
| 6 | Kill switch (optional) | Operator Freeze → buys come back `blocked` ("Spending is frozen…") → Unfreeze. |

## 8. Mocked, unverified and known gaps

| Item | Status |
|---|---|
| `deep_brief` analytics | **LIVE.** Bought for $0.75 on Railway at 12:48 UTC: `accepted`, then `settled` at 13:01 UTC; `mock: false`, `analysis.status: ok`. Computed only from recorded data. The market was flat at the time, so `biggestMove` was `null`. A moving market is shown only in the local [deep-brief-results.json](api-examples/deep-brief-results.json). |
| `full_report` content | **MOCK**, by design. The unlisted seller only demonstrates a block. |
| ElevenLabs voice session through this backend | **UNVERIFIED.** The live endpoint returns 503 until the owner sets `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID`. Field names follow ElevenLabs' docs. |
| ElevenLabs token lifetime | Not documented by ElevenLabs. Request a new one per conversation. |
| `gateway_withdrawal` movement class | **UNVERIFIED.** No withdrawal has happened. |
| Freeze on a real unexpected transfer | Tested with a **synthetic** movement only (labeled in `chain-movements-all-classes.json`). Freeze/unfreeze through the API is LIVE-tested. |
| Odds history coverage | The deployed recorder started at 10:44 UTC; quiet events may chart flat |
| Live push (SSE/WebSocket) | Not built; poll (section 5) |
| Rate limiting | Only for failed logins |
| Your origin in CORS | Not set yet; send it to the backend owner |

## 9. Fixtures

See [api-examples/README.md](api-examples/README.md). Every file carries `_provenance.source`:
- **`live`:** captured from the deployed service. Only GET requests, plus POSTs rejected at validation before any quote or payment. The captures themselves never paid; the purchases they read were made separately.
- **`local-dev`:** real earlier testnet purchases, read through the same API code.
- **`shape`:** produced by the real API code on an in-memory database with throwaway credentials, for states that have no live example.

Session tokens, access codes and ElevenLabs credentials are **redacted**. No `.env` value, private key or backend credential appears in any file; this was checked by a scan against every secret value.
