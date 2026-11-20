# Allowance — frontend

Our UBC 2026 hackathon project. Allowance is a voice-driven AI agent that pays for data one request at a time in USDC on Arc Testnet, within spending rules a person sets: a seller allowlist, spending caps, a daily budget and human approval for bigger purchases. Its data comes from Gemini Prediction Markets. We’re entering the Agentic Payments and AI track with Best use of Arc, plus the Gemini, ElevenLabs and QuickNode Streams bounties. Deadline: Fri Nov 20, 12:00 PM CST

Vite + React + TypeScript + Tailwind.

This folder is the `frontend/` half of the combined Allowance repository; the backend is in `../backend`. See the root `README.md` for the whole system.

## Run it

```bash
cd frontend
npm ci        # Node 22 (Netlify builds with Node 22 too)
npm run dev   # http://localhost:5173 — one of the two local origins the live backend's CORS allows (the other is :3000)
```

Open the URL it prints. The live demo (`#/demo`) talks to the real Allowance backend on Railway and asks for the **demo access code** (get it from the backend owner; it is never stored in this repo). Every payment is real testnet USDC on Arc, inside the backend's spending rules. The Markets page uses live prices and odds.

- Offline, with fake data: `VITE_USE_MOCK=1 npm run dev`. Every mock reply says "(Mock mode)" and the demo shows a **Demo data** badge. Never deploy with it.
- Another backend (e.g. local on :8787): `VITE_API_URL=http://127.0.0.1:8787 npm run dev`
- Variable names are in `.env.example`; copy it to `.env.local` if you want to set them in a file.

No secrets belong in this repo or in any `VITE_` variable: everything in the frontend build is public.

## Where things live

| File | What it does |
|---|---|
| `src/types.ts` | Data shapes shared with the backend. Agree on these first. |
| `src/config.ts` | Mock switch, backend URL, Arc explorer link. |
| `src/api.ts` | The UI's backend interface, plus the offline mock. |
| `src/backend.ts` | HTTP client for the Allowance backend: access-code sessions (memory only), typed endpoints. |
| `src/realApi.ts` | The real backend behind `api.ts`: chat through `POST /api/chat`, and polling of the ledger, budget and onchain feed, turned into UI events. |
| `src/components/VoiceBridge.tsx`, `src/voice.ts` | ElevenLabs voice agent and its 5 client tools. Switches on by itself once the backend has ElevenLabs configured. |
| `src/components/AccessCodeDialog.tsx` | Asks for the demo or operator access code. |
| `src/useAllowance.ts` | All app state. |
| `src/components/` | Pages (landing, live demo, markets), voice panel, payment feed, budget meter, rules panel, approval popup. |
| `src/landing/` | Landing page sections: the hero intro, How it works, and the rules check. |
| `src/markets.ts`, `src/marketsApi.ts` | Markets page watchlist and its live data. |
| `src/index.css` | Brand colors, fonts, and the hero intro's timing (`.hs` block). |

## Live market data (Markets page)

- Prices and charts: Yahoo Finance, through the `/api/yahoo` proxy in `vite.config.ts`.
- Crypto market cap: CoinGecko (optional; prices still work if it's rate-limited).
- Prediction-market odds: Polymarket.

The Yahoo proxy exists in `npm run dev` and `npm run preview` (Vite) and, when deployed, in the repository root's `netlify.toml` (a Netlify rewrite). The backend isn't involved: this page's data is free public data, labelled as such, and is never bought through Allowance.

## Backend integration

The backend contract is in the backend repo, `docs/FRONTEND_HANDOFF.md`. How the UI maps onto it:

| UI | Backend |
|---|---|
| Access-code dialog | `POST /api/sessions` (`agent` scope for the demo; `operator` only for approve, decline, freeze and unfreeze). Tokens stay in memory. |
| Chat (typed, or browser speech) | `POST /api/chat`: the backend's Claude assistant answers and, only when you clearly ask for fresh data, may buy one item per message through the backend's purchase gate. Nothing in the browser decides to buy. One message id per message, so retries never re-run it. Stop cancels the wait (a payment already submitted still stands); New chat starts a new conversation without touching payments. If the backend has no `ANTHROPIC_API_KEY`, chat shows that error and nothing is bought. |
| ElevenLabs voice agent | Its client tools are read-only lookups; its `buy` tool never buys. |
| Payment feed | `GET /api/purchases`, polled every 3 s while something is in flight, otherwise every 5 s. Every state is shown: `accepted` → **Paid · settling on Arc**; `settled` → **Settled on Arc** + tx link; `reserved`/`signed`/`pending_unknown` → **Confirming payment**; `awaiting_approval` → **Waiting for approval**; `needs_review` → **Held for review**; `blocked`/`declined`/`approval_expired`/`aborted`/`rejected`/`expired` → **Not charged** with the backend's reason. |
| Approval popup | Purchases in `awaiting_approval` → `POST /api/purchases/:id/approve` or `/decline` (operator code, asked on click). Shows the exact amount and when the approval closes. |
| Rules panel, budget meter, sidebar | `GET /api/budget` + `GET /api/catalog`, **read-only**: limits are server config. Amounts are the backend's exact labels (`remainingTodayUsdc`, `committedTodayUsdc`, `availableFundsUsdc`) in its budget day and time zone. The Freeze button calls `POST /api/policy/freeze` / `unfreeze` (operator). A **Spending is frozen** banner shows on every demo view while frozen. |
| Onchain activity card (Payments view) | `GET /api/chain/movements` (QuickNode Streams deliveries). `explorer` is optional in the response; the UI falls back to the Arc explorer URL. New transfers while the page is open also appear as an app notice in the chat (not as an AI message). |
| Connection pill | **Live** while polling works; **Session expired · Log in** when the 2-hour agent session ends or the backend rejects it (polls never pop up the login by surprise); **Can't reach the backend** with backoff on network errors. |
| Chat history | The conversation id is kept in `sessionStorage` (this tab only), so a refresh restores the chat from `GET /api/chat/:id` after login. |
| Voice | `POST /api/voice/session` mints an ElevenLabs conversation token. While it answers 503 the mic uses browser speech recognition (Chrome/Edge) and read-aloud; it re-checks every 2 minutes. In a browser with neither, the mic is disabled with an inline explanation. |

The browser has no code path to `POST /api/purchases`: purchases happen only inside the server-side assistant.

Percentages show at most one decimal and are never adjusted to add up to 100%.

## Demo script (live backend, real testnet USDC)

Needs `ANTHROPIC_API_KEY` on the backend, and spending unfrozen by the operator.

1. Open `#/demo` and enter the demo access code.
2. "Hi! What can you do?" → a normal answer; nothing is bought. "Wait" or "stop" never buys.
3. "What are the BTC odds right now?" → the assistant finds the market and buys one 0.005 USDC snapshot; the payment shows **Paid · settling on Arc**, then **Settled on Arc** with the tx a few minutes later. "Explain that" reuses the result without buying again.
4. "Get me a deep brief on Minnesota" → 0.75 USDC is over the 0.25 auto-approve limit, so the approval popup opens → Approve (operator code) → the assistant explains the brief.
5. "Get me the full report on BTC" → blocked: that seller isn't on the allowlist.
6. Rules → Freeze all spending (operator code) → ask for odds again → refused because spending is frozen → Unfreeze.

Each full run commits about 0.78 USDC of the backend's 2.00 USDC daily cap (resets at midnight America/Chicago).

## Still to do

- ElevenLabs: create the agent with the 5 client tools from `backend/voice/client-tools.json` ("Wait for response" on), then set `ELEVENLABS_API_KEY` and `ELEVENLABS_AGENT_ID` on Railway. The mic switches to ElevenLabs automatically.
- Netlify: deploy from the repository root (its `netlify.toml` sets `base = "frontend"`), then add the site's exact origin to the backend's `CORS_ALLOWED_ORIGINS` on Railway. Steps: `docs/DEPLOY.md` §6.
