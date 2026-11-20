# Allowance backend

Backend only. Live at `https://allowance-backend-production.up.railway.app`. **Frontend developers: start with [docs/FRONTEND_HANDOFF.md](../docs/FRONTEND_HANDOFF.md).** Phase 0 holds the payment core and a Circle Gateway nanopayment smoke test on **Arc Testnet**. Design, security model and verification log: [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

**Testnet only.** Never put mainnet keys or real funds in `.env`.

## Setup

Requires Node 22.18 or later (Circle SDK requirement). This folder pins Node 22 in `.nvmrc`.

```bash
cd backend
nvm install && nvm use      # Node 22, this shell only
npm ci                      # exact versions from package-lock.json
npm run typecheck && npm test
```

## Credentials

```bash
npm run keys:generate
```

This creates `backend/.env` (mode 600, gitignored) from `.env.example` with fresh testnet keys, and prints only the two public addresses. It refuses to overwrite an existing `.env`. To use your own testnet keys instead, copy `.env.example` to `.env` and fill in `BUYER_PRIVATE_KEY`, `SELLER_PRIVATE_KEY` and `SELLER_ADDRESS`. The buyer must be an EOA.

Fund the **buyer** address with testnet USDC at <https://faucet.circle.com> (Arc Testnet, USDC). On Arc, USDC is also the gas token.

`npm run keys:generate` is safe to re-run. When `.env` exists, it only **appends** variables that are missing (the unlisted seller, `AGENT_API_TOKEN`, `OPERATOR_API_TOKEN`) and never rewrites existing lines.

## Run the service

```bash
npm run recorder                    # terminal 1: Gemini odds recorder (start early: history begins now)
RECORDER_ENABLED=0 npm start        # terminal 2: API + sellers + reconciler on 127.0.0.1:8787
```

Alternatively, run `npm start` alone and the service runs the recorder itself. Don't run two recorders on the same database.

Then run the end-to-end check. It spends $0.775 of testnet USDC: $0.005 + $0.02, plus $0.75 after operator approval.

```bash
npm run api:smoke                   # optional: -- <search words> to pick the event
```

It must print `✓ all checks passed`.

### Frontend and voice (Phase 2)

1. In `backend/.env`, set `CORS_ALLOWED_ORIGINS` to the frontend's origin.
2. For voice, also set `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID`. Without them, `POST /api/voice/session` answers 503 `voice_not_configured`.
3. People log in with `DEMO_ACCESS_CODE` (agent session) or `OPERATOR_ACCESS_CODE` (operator session). Both are in `backend/.env`.
4. Then run:

```bash
npm run voice:smoke                 # CORS, logins, scopes, voice endpoint, one $0.005 purchase, approval guard
```

The integration contract is in [docs/VOICE_INTEGRATION.md](../docs/VOICE_INTEGRATION.md); the tool definitions are in `voice/client-tools.json`.

### Quicknode Streams and deploy (Phase 3)

```bash
npm run streams:filter              # writes streams/filter.js for this agent wallet (paste into Quicknode)
npm run streams:simulate            # signed test deliveries to the running service (needs QN_STREAM_SECURITY_TOKEN)
docker build -t allowance-backend . # single-instance container; see docs/DEPLOY.md
```

The webhook is `POST /webhooks/quicknode`. It's HMAC-verified with `QN_STREAM_SECURITY_TOKEN` and answers 503 until that is set. Host setup and Stream settings are in [docs/DEPLOY.md](../docs/DEPLOY.md).
- **Auth model:** agent routes take `AGENT_API_TOKEN`. Approve, decline, freeze and unfreeze take only `OPERATOR_API_TOKEN`.
- **Reference:** API table, purchase states and test list are in [docs/ARCHITECTURE.md §7](../docs/ARCHITECTURE.md).
- **Database:** `backend/data/allowance.db` (gitignored).

## Phase 0 smoke test (payment rail only)

Run the seller in one terminal. It listens on 127.0.0.1 only, and on startup cross-checks the live Gateway against the SDK constants:

```bash
npm run smoke:seller
```

Then run these in a second terminal:

```bash
npm run smoke:balance                      # native (18 dec), ERC-20 (6 dec, read onchain) and Gateway balances
npm run smoke:deposit                      # dry run
npm run smoke:deposit -- --yes             # approve + deposit DEPOSIT_USDC into Gateway (onchain)
EXPECTED_PRICE_USDC=0.004 npm run smoke:buy   # negative test: must print "REFUSED before signing", exit 3
npm run smoke:buy                          # pays SMOKE_PRICE_USDC once; prints nonce + Gateway transfer id
npm run smoke:status -- --wait 25          # follows the last payment until batch settlement
npm run smoke:status -- --nonce 0x...      # reconcile a payment whose outcome was unknown
```

### `smoke:buy` exit codes

| Exit | Meaning |
|---|---|
| 0 | Payment accepted and resource delivered |
| 3 | The 402 offer didn't match the approved terms; nothing signed |
| 4 | Not enough Gateway balance; nothing signed |
| 5 | Outcome unknown (timeout or 5xx). Treat the payment as spent and reconcile with `smoke:status -- --nonce` |

Run logs with public identifiers only (nonces, transfer ids, tx hashes) go to `backend/.smoke/*.jsonl`, which is gitignored.

## What a nanopayment does onchain

A payment is an **offchain** EIP-3009 authorization. Gateway debits the buyer's Gateway balance right away and later settles many authorizations in a single batch transaction. Expect a Gateway transfer id with `txHash: null` at first; one batch transaction appears later. The only buyer-initiated onchain transactions are the approve and deposit.
