# Deploy and Quicknode Streams runbook

As of 2026-11-20. Status labels: **Verified** / **Not verified** / **Assumption**.

## 0. Current deployment (live)

**`https://allowance-backend-production.up.railway.app`**: Railway project `allowance-backend`, service `allowance-backend`, environment `production`. Deployed 10:44 UTC with `railway up` from `backend/`; no Git push was needed.

| Item | State |
|---|---|
| Build | Dockerfile built on Railway (linux/amd64), including the native `better-sqlite3` module. **Verified.** Railway rejects `VOLUME` in a Dockerfile, so that line was removed. |
| Upload | 81 kB snapshot. `.railwayignore` keeps out `.env`, `node_modules`, `data`, `.smoke` and `*.db*`. |
| Volume | `allowance-backend-volume` mounted at `/data`, 0.5 GB (Free/Trial size). Volumes mount as root, so `RAILWAY_RUN_UID=0` is set, per Railway's docs. The recorder's writes prove it's writable. |
| Variables (names only) | Buyer key, both seller addresses, both API tokens, `SESSION_SECRET`, both access codes, `GATEWAY_API_URL`, `AUTH_VERSION`, `PORT=8787`, `RAILWAY_RUN_UID`, `RECORDER_ENABLED=1`, `CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173`, and the policy defaults. Values were sent with `railway variable set --stdin`, never on a command line. Seller private keys were **not** uploaded. |
| Not set yet | `QN_STREAM_SECURITY_TOKEN` (the webhook answers 503 until set), `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`. Add the deployed frontend's origin to `CORS_ALLOWED_ORIGINS` when it exists. |
| Live checks | `/health` ok. Unauthenticated API 401. Seller 402 over HTTPS. CORS 204/403. `voice:smoke` against the live URL: **all checks passed**, including a real $0.005 nanopayment made from Railway (snapshot with spoken summary), the $0.75 brief held, the agent's approve refused, and the operator decline. Committed $0.005 of $2, Gateway available $2.205. |
| Cutover | The local `npm start` was stopped, so Railway is the only spending instance for this buyer key. The local `npm run recorder` still runs; it doesn't spend, and it keeps the history recorded since 09:49 UTC. Railway's history starts at 10:44 UTC. |

**Deploy history:**

| Deployment | When (UTC) | What |
|---|---|---|
| `9f50b4ea` | 10:42 | **Failed:** Railway rejected the Dockerfile's `VOLUME` line (line removed) |
| `e59dc4da` | 10:43 | First successful deploy |
| `ebd6b131` | 11:19 | `QN_STREAM_SECURITY_TOKEN` applied |
| `f2cbc485` | 11:31 | Redeploy not triggered by the CLI here; most likely a dashboard variable change |
| `da8d9547` | 11:46 | Streams receiver fix (parse any wrapper, raw-log fallback) |
| `7d400e4a` | 12:34 | Real deep brief from recorded data. Live-verified with one paid brief at 12:48, settled at 13:01 ([ARCHITECTURE §10](ARCHITECTURE.md)). |
| `315e6c55` | 13:11 | Percent display (at most one decimal, never normalized) and the new deep_brief catalog text. **Current.** |

Checks after the 12:34 deploy:
- health ok;
- recorder resumed at poll 103, so the volume persisted;
- ledger and budget unchanged;
- unsigned webhook 401, CORS 204;
- no webhook traffic during the restart.

Checks after the 13:11 deploy (non-billable; no purchase, approval or budget change):
- health ok;
- recorder resumed at poll 138 (1,003 events), so the volume persisted;
- ledger (3 rows), budget ($0.755 committed, $1.955 Gateway), the stored brief result and chain movements unchanged;
- the new catalog text is served;
- the snapshot summary reads "51.5% / 48.5%";
- the seller answers 402 without payment;
- unauthenticated 401, agent approve 401, voice 503, CORS 204/403.

Change settings with `railway variable set NAME --stdin --service allowance-backend`, then redeploy. Read logs with `railway logs --service allowance-backend`.

## 1. What runs

A single container built from [backend/Dockerfile](../backend/Dockerfile): one Node 22 process serving the API, the x402 sellers, the reconciler, the odds recorder and the Streams webhook.

- **Single instance only.** SQLite lives on the `/data` volume, and the daily cap is enforced inside that database.
- **One instance per buyer key.** Two instances with the same `BUYER_PRIVATE_KEY` would each allow $2/day against one shared Gateway balance. Stop the local `npm start` once the deployment is live.
- **Fresh state.** A new volume starts empty, so odds history begins at deploy time and today's local ledger isn't carried over. To keep them, copy `backend/data/allowance.db` (with the service stopped) into the volume before first start. How you copy depends on the host.

| Check | Status |
|---|---|
| Container start command with `HOST=0.0.0.0`, fresh `DB_PATH`, recorder on: health 200, migrations 1–3, first poll 1,003 events, clean SIGTERM | **Verified** (run outside Docker on port 8799) |
| `docker build` (multi-stage, `better-sqlite3` native module on Linux) | **Verified on Railway** (linux/amd64). Not built locally, because the Docker daemon isn't running on this Mac. |
| Base image `node:22.23.5-bookworm-slim` (amd64, arm64) | **Verified** (Docker Hub tag is active) |

## 2. Environment for the deployed service

Set these as host secrets or variables. Never bake them into the image; `.dockerignore` excludes `.env`.

| Variable | Notes |
|---|---|
| `BUYER_PRIVATE_KEY`, `SELLER_ADDRESS`, `UNLISTED_SELLER_ADDRESS` | Testnet only. The seller *private* keys aren't needed by the service. |
| `AGENT_API_TOKEN`, `OPERATOR_API_TOKEN`, `SESSION_SECRET`, `DEMO_ACCESS_CODE`, `OPERATOR_ACCESS_CODE` | From `backend/.env`, or generate fresh ones for production |
| `QN_STREAM_SECURITY_TOKEN` | From the Stream's webhook settings (section 4) |
| `CORS_ALLOWED_ORIGINS` | The deployed frontend's origin |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID` | When voice is ready |
| `GATEWAY_API_URL` | Leave as the testnet default |

The image already sets `HOST=0.0.0.0`, `PORT=8787`, `DB_PATH=/data/allowance.db` and `RECORDER_ENABLED=1`. Leave `PUBLIC_BASE_URL` unset: the built-in sellers are reached over loopback.

## 3. Host options

| Option | What you get | What it needs from you |
|---|---|---|
| **Railway** (recommended) | A stable HTTPS URL that survives your laptop sleeping. Deploy from the local folder with the CLI, no Git push needed. | A Railway account, installing and logging into its CLI, a volume mounted at `/data`, and the variables above. **Assumption:** volume availability and CLI behavior on your plan are unverified. |
| **Quick tunnel** (Cloudflare `cloudflared`, no account) | A public HTTPS URL for the service running on your laptop, in under a minute | Installing `cloudflared`. The URL changes on every restart, and your laptop must stay on. Fine for the in-person demo; risky for a Devpost link judges open later. |
| Render / Fly.io | Similar to Railway | Render's free tier has no persistent disk. Fly needs a card. Not explored further. |

After deploying, check:
1. `curl https://<host>/health` returns `{"ok":true}`.
2. `curl -X POST https://<host>/webhooks/quicknode` returns 401 (token set) or 503 (not yet set).
3. Run `npm run voice:smoke` with `PUBLIC_BASE_URL=https://<host>` set for that command only.

## 4. Quicknode Stream setup (you, in the Quicknode dashboard)

1. **Network:** Arc **Testnet**. Supported with the Logs dataset (**Verified**, supported-chains table). The CLI slug is probably `arc-testnet` (**Assumption**: the docs' example uses `arc-mainnet`).
2. **Dataset:** Logs.
3. **Filter:** paste [backend/streams/filter.js](../backend/streams/filter.js), generated by `npm run streams:filter` for the agent wallet `0xE5ED…8fbd`. Test it on blocks **73167868** (faucet top-up of 20 USDC), **73167978** and **73173107** (Gateway deposits of 1 and 2 USDC). Each should return exactly one movement. **Verified** offline against these blocks' real logs.
4. **Batch size:** set `dataset_batch_size` to 5 or more and turn **elastic batch** on. Quicknode recommends this for sub-second chains like Arc (**Verified**, REST docs). Reorg handling can stay off, since Arc has deterministic finality.
5. **Start block:** latest, or 73167868 to backfill the three real movements for the demo.
6. **Destination:** Webhook to `https://allowance-backend-production.up.railway.app/webhooks/quicknode`.
   - Compression: none or gzip; both are handled.
   - Keep the default timeout (30 s), retry interval (1 s) and pause-after (3 failures).
7. **Security token:** set it as `QN_STREAM_SECURITY_TOKEN` on the Railway service, which redeploys automatically. Either enter it in the Railway dashboard, or add it to `backend/.env` and pipe it with `railway variable set QN_STREAM_SECURITY_TOKEN --stdin`. Never paste it into chat or a command line.
   - The receiver verifies `X-QN-Signature`: HMAC-SHA256 over nonce + timestamp + body.
   - It rejects timestamps outside ±5 minutes and replayed nonces.
   - The secret is never in the URL.
8. **Assumption:** the webhook body is the filter's return value (`{movements:[…]}`). The receiver also accepts `{data:{movements}}`. Confirm on the first real delivery: the service log prints `[streams] delivery …: N movement(s)`.

### 4.1 Check Connection returns 401: expected, and authentication stays on

Findings from 2026-11-20:
- **Check Connection is unsigned.** At 11:19:57 UTC, Quicknode's Check Connection reached `POST /webhooks/quicknode` and got **401 `missing_signature`**, so it sent no X-QN signature headers.
  - Quicknode's webhook docs describe it only as a reachability check ("verify your endpoint is reachable before creating the stream"; with mTLS it also tests the handshake). Nowhere is it described as signed.
  - Quicknode's reference verifier ([quiknode-labs/streams-webhook-validate-signature](https://github.com/quiknode-labs/streams-webhook-validate-signature)) also rejects requests without the headers.
  - A 401 here proves DNS, TLS, the route and enforcement all work.
- **Our verifier matches Quicknode's format.**
  - Headers `X-QN-Nonce`, `X-QN-Timestamp`, `X-QN-Signature`.
  - Hex HMAC-SHA256 keyed with the security token, over `nonce + timestamp + payload` as UTF-8, with the payload being the decompressed JSON.
  - A unit test checks this against a vector computed independently with the guide's Python code.
- **The deployed verifier works with the live token.** Signed test requests (token read from Railway into memory, never printed; empty movement list, so no data changed) gave:

  | Request | Result |
  |---|---|
  | Correctly signed | 200 |
  | Correctly signed, gzip body | 200 |
  | Signature altered | 401 `invalid_signature` |
  | Timestamp 1 h old | 401 `stale_signature` |
- **Unchanged on purpose:** no static headers, no exception for unsigned requests, and nothing that answers 2xx to them. mTLS isn't an option behind Railway's proxy, which terminates TLS.

**How to validate a real delivery.** Activate the Stream either from block **73167868** (backfills the three known real movements) or from **latest**, then make a real Gateway deposit (`npm run smoke:deposit -- 0.5 --yes`). Then:
1. **Railway HTTP log** (`railway logs --http`): `POST /webhooks/quicknode 200` at the delivery time.
2. **App log** (`railway logs --filter streams`): `[streams] delivery <nonce>: N movement(s), N new`. That line is written only after the signature, freshness and replay checks pass.
3. **API:** `GET /api/chain/movements` (agent token) shows the movement with its real transaction hash and the right class (`gateway_deposit` for a deposit). Open the hash on the Arc explorer to cross-check.
4. **If a real delivery gets 401:**
   - App log says `rejected delivery: invalid signature` → the token on Railway isn't this Stream's current token. Recopy it; rotating it invalidates the old one.
   - App log says `timestamp outside ±300s` → clock skew.
   - A 401 with no app log line → the delivery had no signature headers. Check the Stream's destination security settings.

   Quicknode retries and then pauses the Stream after 3 failures, so reactivate it after fixing.

### 4.2 Real-delivery test, 2026-11-20 (results)

| Step | Result | Status |
|---|---|---|
| Deployed config | `QN_STREAM_SECURITY_TOKEN` present: 54 chars, no whitespace, checked by name and length only. Webhook verifier on since 11:19:41 UTC. Unsigned POST → 401. | **Verified** |
| Connection test unsigned | 11:19:57 UTC: 401 with **no** app-log line. Bad signatures and stale timestamps always log a line, so the request had no X-QN headers. | **Verified** |
| Stream live | Active and delivering. Signed batches about every 0.4 s, **all 200**, 0 rejections. | **Verified** |
| 0.5 USDC deposit | tx [`0x9e9926e24505513b1f85ce3793a4aa08b55e3f14e650a61dcd4244756a3a6239`](https://explorer.testnet.arc.io/tx/0x9e9926e24505513b1f85ce3793a4aa08b55e3f14e650a61dcd4244756a3a6239), block 73182200. Gateway credited in 5 s (2.205 → 2.705). | **Verified** |
| Deposit recorded? | **No.** After 3.5 min the live service had 0 movements; every delivery logged "0 movement(s)". | **Failed** |

**Root cause (two parts):**
1. **Stream configuration.** The Stream sends **unfiltered receipts**, not filter output. The payload shape logged after deploy `da8d9547` was `{data:[[{type,status,…,logs:[…],transactionHash,…}]], metadata:{…}}`.
2. **Our receiver.** It only read a top-level `movements` field, so the deposit's log arrived inside a verified receipt and was **dropped silently**.

**Fix (deployed `da8d9547`, 11:46 UTC). Verification is unchanged; everything below runs only after the signature, freshness and replay checks pass.**
- Filter output is found anywhere in the body.
- Raw logs and receipts get the filter's exact rules applied server-side. A parity test runs both against the real Arc logs.
- The receiver logs the payload *shape* (keys and counts only) and a warning when the Stream is unfiltered.
- Empty deliveries are summarized every 5 minutes instead of logged one by one.
- Replay nonces are pruned after the freshness window.
- `streams/filter.js` now also walks `receipt.logs`, so it works on Logs and Receipts datasets alike.

**Re-delivery and final result (12:05 UTC). Verified.** Stream edited by the user: filter pasted, start block 73182190, same token, reactivated.

| Check | Result |
|---|---|
| Delivery | `[streams] delivery f396d5161943: 1 movement(s), 1 new` at 12:05:08 UTC. It came from the **Quicknode filter** output (no "from raw logs" tag), so the Stream is now filtered. |
| Recorded row | `5042002:0x9e9926e2…6239:7`, block 73182200, from `0xe5ed…8fbd` (agent) to `0x0077…19b9` (Gateway Wallet), **0.5 USDC**, `gateway_deposit` |
| Exactly once | 1 row for the transaction at first sight, and still 1 row 45 s later. Total movements 1. No duplicate or second "new" line. |
| Onchain cross-check | Receipt log 7 is the native emitter Transfer, 500000000000000000 (0.5 at 18 decimals) = the recorded row. Log 8, the `0x3600…` 6-decimal mirror, was correctly **not** recorded. Log 9 is the Gateway event. |
| Safety state | Not frozen; deposits never freeze. 0 signature rejections. |
| Non-200 since 11:30 | One: 401 at 11:54:44 with no app-log line, so it was unsigned. It matches dashboard activity during the edit (Check Connection). Not a real delivery. |

Signature verification stayed on for the whole test.

**What the Stream will and won't show:**
- **It shows** top-ups to the agent wallet, its Gateway deposits and withdrawals, and any other outbound transfer. Any outbound transfer that isn't a Gateway deposit **freezes spending**.
- **It never shows individual nanopayments.** Gateway's batch settlements emit no USDC Transfer logs (**Verified** on two settlement transactions). Payment status comes from the reconciler.

## 5. What was tested (Phase 3)

| Test | Result |
|---|---|
| `npm test` | 43/43. The 6 new tests: filter on real Arc logs (3 kept; 3 mirror logs and 2 Gateway events dropped); classification; unsigned, wrong-token, tampered and stale deliveries refused; replay and gzip; exact 18→6 conversion and raw-only storage for inexact amounts; synthetic anomaly freezes spending; foreign-chain movements ignored. |
| `npm run streams:simulate -- --anomaly` against the running service | Tampered → 401. Real deliveries stored: top-up 20, deposits 1 and 2. Replay deduplicated. Synthetic outbound froze spending with a reason; the operator unfroze it. **Mocked:** Quicknode's transport (we signed the requests ourselves with a local test token) and the anomaly log. |
| Real Quicknode delivery | **Not done.** Needs a public URL and the Stream. |

The local development database now contains that one synthetic anomaly (block 1, tx `0x36e4…7562`, `unexpected_outbound`). It doesn't affect spending, since the freeze was lifted. A deployed instance starts without it.
