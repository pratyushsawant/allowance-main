# Allowance backend: status assessment

As of **2026-11-20, 13:15 UTC (07:15 CST)**, live deployment `315e6c55`. Measured against [PROJECT_BRIEF.md](../PROJECT_BRIEF.md) and the agreed backend-only scope (Phases 0–3 plus the deep brief, [ARCHITECTURE.md](ARCHITECTURE.md)).

## Verdict: demo-ready with gaps

Every money-moving path runs on Arc Testnet and was verified live:
- payments bound to approved terms;
- policy blocks;
- operator-only approval, including approve → pay → settle on Railway;
- ledger and settlement reconciliation;
- Quicknode-driven monitoring;
- market recording;
- the real deep brief, bought live at 12:48 UTC and settled at 13:01 UTC ([details below](#live-deep-brief-check-2026-11-20));
- the deployed service.

It is **not complete**:

| Gap | State |
|---|---|
| Voice | Never exercised. Blocked on ElevenLabs credentials. |
| CORS | The teammate's frontend origins aren't configured |
| Top-ups | Recorded, but not turned into spendable funds automatically |
| Submission | No root README, consolidated repository or commits yet |

Status key:
- **Live-verified:** exercised against real services on Arc Testnet or the deployed backend.
- **Implemented, unverified:** built and covered by tests (deployed where noted), never exercised live.
- **Mocked:** placeholder output.
- **Missing:** not built.

## Feature status

| Area | Status | Evidence |
|---|---|---|
| **x402 nanopayments via Circle Gateway, Arc Testnet** | **Live-verified** | Phase 0: transfer `129cc325…` settled in batch tx `0x76d3dcab…`. Phase 1: three payments settled together in batch tx `0x8c631452…`. Railway: snapshot paid and `settled`. Railway: $0.75 deep brief, transfer `a2c61405…` settled in batch tx `0xa08d1c7b…` (block 73191738). [ARCHITECTURE §4, §7.5](ARCHITECTURE.md). |
| Payment bound to approved terms (payee, amount, asset, network, contract, validity) | **Live-verified** for refusal and for the approved brief; tampering tested offline | Live: a price mismatch was refused before signing. The approved brief was re-quoted at approval time and paid only at the held terms (750000 base units to the allowlisted seller). Offline: the real Circle SDK signs through the guarded signer, and a tampered amount or payee is refused without using the key (`x402.test.ts`). |
| Gateway deposits | **Live-verified** | `0x3e0c…` (1 USDC), `0x7546…` (2), `0x9e99…` (0.5), each credited in 5–9 s |
| **Policy enforcement** | **Live-verified**: allowlist, freeze, insufficient funds, $0.25 approval threshold. **Implemented, unverified live**: per-call and daily-cap boundaries. | Live: `full_report` blocked (unlisted payee), snapshot blocked while frozen, $0.75 brief blocked at $0.215 funds and held for approval when funded ("$0.75 is over the $0.25 auto-approve limit"). Offline: `policy.test.ts`, plus 10 parallel buys → exactly 8 paid and 2 blocked (`purchase-flow.test.ts`). |
| **Approvals** (operator-only) | **Live-verified** | Local: operator approved → paid. Railway: brief held, **agent token on approve → 401**, operator decline → `declined`, and operator approve → paid once → `settled` (purchase `7ddb7cf0…`). |
| **Ledger, idempotency, reconciliation** | **Live-verified**: idempotency, single charge per approval, settlement tracking. **Implemented, unverified live**: timeout/pending, expiry release, crash recovery. | Live: repeated key returned the same purchase with no second payment. Live brief: exactly one ledger row charged; committed spend $0.005 → $0.755 and Gateway available $2.705 → $1.955, both exactly $0.75; one `[buyer] … -> accepted` log line. The reconciler moved it from `accepted` to `settled` 12 min 54 s later. Offline: a hanging seller → `pending_unknown`, held until Gateway or expiry decides. |
| **Market recording** (Gemini Prediction Markets) | **Live-verified** | Railway poll 107 at 12:38 UTC: 1,003 events, 10,715 contracts, change-only rows. It resumed from the volume after the redeploy (poll 96 → 103 → 107). The live brief reported 123 minutes of Railway coverage with 1 failed poll. |
| Odds history and movers (`odds_history`) | **Live-verified** (data); the new "not enough history" summary is **implemented, unverified live** | A paid history purchase (local) returned real points. The summary now separates "no change" from "not enough history" (deployed 12:34; 55/55 tests). |
| **Deep-brief analytics** (`deep_brief`) | **Live-verified** (Railway, 12:48 UTC) | Bought live for $0.75: `mock: false`, `analysis.status: ok`, both contracts with 9 observations over 123 minutes, no movement reported because prices didn't change, 5 related events each analysed `ok`, data-quality note "1 recorder poll(s) failed in this window", no placeholder text. Offline: 8 tests in `brief.test.ts`, and `insufficient_history` shown on a newly listed event ([deep-brief-results.json](api-examples/deep-brief-results.json)). Limitation: "related" means the same broad Gemini category. |
| `full_report` content | **Mocked**, by design | The unlisted seller exists only to show a block; policy never allows the purchase |
| Spoken summaries | **Live-verified** (snapshot and brief) | Snapshot, after deploy `315e6c55`: "Minnesota about 51.5%, Oklahoma State about 48.5%…". Brief (bought before that deploy, so it keeps whole numbers): "Minnesota vs Oklahoma State: Minnesota leads at about 52%; no change since 4:44 AM. Related: …" |
| Percent display | **Live-verified** for the snapshot summary. **Implemented, unverified live** in a new paid brief, because no brief has been bought since the deploy. | At most one decimal, each value on its own, never normalized to 100%; totals come from `probabilitiesSum` (exact sum of midpoints). Unit tests: 0.515 → "51.5%", 0.485 → "48.5%", an overround book → "102%" (`percent.test.ts`, `brief.test.ts`). Offline preview of the deployed code on local recorded data: Minnesota 51.5%, Oklahoma State 48.5%, sum 100%. Stored results are never rewritten. |
| **ElevenLabs voice-session endpoint** | **Implemented, unverified** | Railway: **503 `voice_not_configured`** with valid credentials; 401 with a bad one. Offline: URL, header, no key leakage, 502 on an upstream error (`voice-api.test.ts`). The token lifetime isn't documented by ElevenLabs. |
| ElevenLabs agent and its 5 client tools | **Missing** (account configuration, not code) | Tool contract ready ([client-tools.json](../backend/voice/client-tools.json)); no agent created yet |
| **Authentication and roles** | **Live-verified** | Railway: wrong access code → 401, agent (2 h) and operator (1 h) sessions issued, agent can't approve or unfreeze, unauthenticated API → 401. Failed-login limit (10 per 10 min) tested offline. |
| CORS | **Live-verified** for `http://localhost:3000` and `:5173`. **Missing** for the teammate's real origins. | Preflight 204 for an allowed origin, 403 otherwise. Waiting on exact origins. |
| **Quicknode Streams webhook** | **Live-verified** | Real deposit `0x9e99…6239` delivered by Quicknode, HMAC-verified, recorded **exactly once** as `gateway_deposit`; 0 signature rejections ([DEPLOY §4.2](DEPLOY.md)). |
| Freeze on an unexpected outbound transfer | **Implemented, unverified** on real chain data | Synthetic movement only (local and offline). No real outbound transfer has happened. |
| "Confirmed top-ups raise the budget" (brief) | **Partial** | Top-ups are recorded as `top_up`. Spendable funds (the Gateway balance) rise only after a deposit. Auto-deposit isn't built; it's your decision. |
| `gateway_withdrawal` classification | **Implemented, unverified** | No withdrawal observed |
| **Deployment** (Railway, single instance, volume, health) | **Live-verified** | `https://allowance-backend-production.up.railway.app`, deployment `315e6c55` (13:11 UTC). Docker build on Railway, volume at 34 of 500 MB, local spending service stopped. After the redeploy:
- recorder resumed at poll 138;
- ledger, budget and chain movements unchanged;
- the new catalog text is served;
- auth, CORS, voice and the seller's 402 behave as before. Full deploy history is in [DEPLOY §0](DEPLOY.md). |
| **Frontend integration package** | **Implemented** | [FRONTEND_HANDOFF.md](FRONTEND_HANDOFF.md): base URL, roles, sessions, endpoints, states, polling, errors, demo flow, two-repo and CORS instructions. 22 labeled fixtures in [api-examples/](api-examples/README.md), secret-scanned clean. The deep-brief fixture is now the live purchase (captured 13:04 UTC). |
| Live push to the UI (SSE/WebSocket) | **Missing**, by choice | Polling contract documented ([FRONTEND_HANDOFF §5](FRONTEND_HANDOFF.md)) |
| General API rate limiting | **Missing** | Only failed logins are limited |
| README sections the prizes require (decision loop, safety limits, Arc addresses, Gemini endpoints, ElevenLabs products, Stream setup) | **Partial** | The content exists across ARCHITECTURE, DEPLOY and VOICE_INTEGRATION; there's no root README yet |
| Repository: consolidated `/frontend` + `/backend`, commits | **Missing** | Local backend repo, 0 commits, nothing pushed |
| Tests | **Passing** | `npm test`: **61/61** and `tsc --noEmit` clean at 13:10 UTC (6 new: percent formatting, the overround case, the catalog text) |

## Live deep-brief check (2026-11-20)

One purchase, authorized in chat for at most 0.75 USDC on Arc Testnet. It went through the normal approval flow: no policy bypassed, no limit changed, no retries, and no other purchase.

| Step | Time (UTC) | Result |
|---|---|---|
| Pre-check | 12:47:45 | 2 ledger rows, committed $0.005 of $2.00, Gateway available $2.705, not frozen, deployment `7d400e4a` |
| Request (agent token, one POST, key `live-brief-check-20261120-01`) | 12:48:15 | `awaiting_approval`, "$0.75 is over the $0.25 auto-approve limit". 750000 base units (6 decimals), payee = the allowlisted Odds Desk seller, nothing signed (`nonce: null`). Approval window until 12:58:15. |
| Approve (operator credential, sent once) | 12:48:31 | HTTP 200 in 544 ms. Fresh quote checked against the held terms, signed once, seller answered 200 → **`accepted`**: Circle Gateway accepted the payment (transfer `a2c61405-87b1-439c-bd75-441850dbd86b`). Not settled yet: `settlementTx: null`. |
| Batch settlement onchain | 13:01:01 | Tx [`0xa08d1c7ba089260c0e53232d7b0fa77f6b04aafe7b5d7db22a5b3ea90d71a9ca`](https://explorer.testnet.arc.io/tx/0xa08d1c7ba089260c0e53232d7b0fa77f6b04aafe7b5d7db22a5b3ea90d71a9ca), block 73191738, receipt status `success`, sent to the GatewayWallet. The link from transfer to tx comes from Circle's transfer record. |
| Reconciler | 13:01:25 | **`settled`**, 12 min 54 s after acceptance |
| Ledger after | 13:01:27 | 3 rows: this brief `settled` $0.75, the earlier brief `declined` (never charged), the snapshot `settled` $0.005. Committed $0.755 of $2.00; Gateway available $1.955. Exactly one charge for this brief. |

**Acceptance and settlement are different steps.** Acceptance (12:48:31) means Gateway accepted the signed authorization and the seller delivered. Settlement (13:01) is the batch transaction landing on Arc. The deliverable came at acceptance; the money reached the chain about 13 minutes later.

**What the brief contained**: real analytics, not the placeholder.
- `mock: false`. The note says it was computed only from recorded Gemini prices.
- Method: implied probability is the midpoint of best bid and ask. Movement needs ≥ 2 observations, ≥ 15 minutes of history, and no gap over 10 minutes.
- Event: Minnesota vs Oklahoma State (`NCAAM-2611201730-MINN-OKST-M`). Status `ok`, Minnesota leads (mid 0.515), Oklahoma State 0.485, spread 0.01 on each.
- History: 9 observations over 123 minutes with no change, so `biggestMove` is null and no movement was invented.
- Data quality: 1 failed recorder poll in the window, reported as a note.
- Related: 5 events from the same category, each analysed `ok`.

**Minor findings, fixed in deploy `315e6c55` (13:11 UTC):**
- **Rounding:** this brief shows 52% and 49% (0.515 and 0.485 rounded up separately, so the two add to 101%). New results show 51.5% and 48.5%. Percentages are never forced to add up to 100%, and `probabilitiesSum` stays the exact total. This purchase's stored result was not rewritten.
- **Catalog text:** the old description, "Related markets in the same category with current odds.", is replaced by one that describes the recorded-price analysis and the history rule.

## The brief's demo moments, backend side

| Moment | Backend status |
|---|---|
| Pays $0.005 on its own | Live-verified |
| Asks before a $0.75 purchase | Live-verified on Railway end to end: held, agent can't approve, operator approves, paid once, settled |
| Refuses a seller not on the allowlist | Live-verified |
| Logs every cent in a live ledger | Ledger API live-verified; the UI is the teammate's |
| Analytics: odds moved today → chart | Data live; often flat overnight; the chart is the teammate's |
| Deep brief after approval | Live-verified (real analytics; flat market at the time) |
| Onchain proof: Stream event lands | Live-verified with a deposit. A faucet top-up is recorded, but the budget doesn't rise until a deposit. |

## Remaining blockers, in priority order

| # | Blocker | Owner | Notes |
|---|---|---|---|
| 1 | ElevenLabs: create the agent with its 5 client tools ("Wait for response"), require authentication, and set `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` on Railway. Then the backend verifies a live voice session. | **You** (account), then **backend** | No voice without it; the ElevenLabs bounty needs audio in the video |
| 2 | Exact frontend origins → CORS on Railway | **Teammate** supplies them; **backend** sets them | Exact origins only, no wildcards, no per-deploy preview URLs |
| 3 | Root README with the prize-required sections; consolidate into `/frontend` + `/backend`; first commits | **Backend** drafts; **you** decide on publishing | Re-verify the hackathon's repository-access rule first (the brief's guide says "a public GitHub repo") |
| 4 | Decide whether a confirmed top-up auto-deposits into Gateway | **You** decide; **backend** builds | Until then the demo shows the deposit event |
| 5 | Rehearsal budget: each full demo run commits $0.775 of the $2/day cap | **You** decide | Today (America/Chicago): $0.755 used, $1.245 left, so one more full run fits today. Gateway holds $1.955, about two full runs before another deposit. |
| 6 | Optional: real unexpected-outbound test (send 0.01 USDC from the agent wallet to our own seller) to prove the freeze on real data | **Backend**, with your approval (it moves funds) | Synthetic only so far |

## Frontend teammate's tasks (not backend)

- **Build the UI pieces:** voice panel, live ledger, budget meter, approval card with countdown, freeze toggle, odds step-chart from `odds_history` points, onchain movements feed. Each maps to an endpoint in [FRONTEND_HANDOFF §3–5](FRONTEND_HANDOFF.md).
- **Percentages:** show each string as given, at most one decimal. Display `probabilitiesSum` for a total; never add the per-contract strings. Parse with `parseFloat`; older stored results use whole numbers ([FRONTEND_HANDOFF §3](FRONTEND_HANDOFF.md)).
- **Show settlement separately:** `accepted` (paid, result available) and `settled` (onchain, `settlementTx` set) are separate states. Settlement took about 13 minutes in the live check.
- **Sessions:**
  - the person types access codes at runtime;
  - the agent token is the only one tool handlers see;
  - the operator token sits in a separate module and is requested only on Approve, Decline, Freeze or Unfreeze;
  - tokens live in memory only.
- **ElevenLabs React wiring:**
  - `clientTools` handlers that call the API;
  - one idempotency key per `buy`, reused on retries;
  - `sendUserMessage` after approval;
  - a spoken alert when `frozen` flips;
  - a text-only fallback while voice is unconfigured.
- **Polling and back-off** as documented.
- **Their own repository and deployment**, then send the exact origins.
- **The demo recording** of the UI with audio on.

## Two-repository development, then consolidation

- **Now:** the frontend and backend are separate private repositories, deployed independently. The frontend uses the backend's public HTTPS URL. CORS allows only exact listed origins. No backend secret or static credential ships in the frontend.
- **Before submission:**
  - consolidate into one repository with `/frontend` and `/backend`;
  - write a root README and separate deployment instructions per part;
  - a root `.gitignore` must keep out `.env*` (except `.env.example`), `backend/data/`, `*.db*`, `backend/.smoke/`, `node_modules/` and frontend build output;
  - run a secret scan before the first commit;
  - verify the hackathon's repository-access requirement before choosing public or private.
