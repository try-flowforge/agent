# FlowForge Agent

A service that lets users create and run workflows from natural language. It is an alternative to the web app: users can either use the canvas and web UI, or interact entirely via Telegram.

Built for the EigenCloud Open Innovation Challenge as a verifiable agent - deterministic planning and replay-proof execution.

## What it does

- **Natural language to workflows**: Describe what you want in plain language; the agent turns it into a workflow and can run it for you.
- **Telegram-first**: Commands like `/start`, `/link`, `/create`, `/confirm`, `/status` handle setup, workflow creation, approval, and execution status.
- **Identity via web bootstrap**: One-time link from Telegram to a minimal web page for Privy login and Safe wallet setup; after that, everything happens in Telegram.
- **Verifiable**: Planning uses deterministic inference; execution and proofs are designed for the EigenCloud verifiability story.

## Commands

| Command | Purpose |
| ------- | ------- |
| `/start` | Welcome and prompt to link account |
| `/link` | Get a one-time URL to authenticate and link this chat to your account |
| `/create <prompt>` | Generate a workflow from your natural-language description |
| `/confirm` | Approve and execute the pending workflow |
| `/status` | Check execution status |

## Requirements

- Node.js 20+
- Environment variables (see `.env.example`): Telegram bot token, backend URL, service key, LLM service URL for deterministic planning.

## Run locally

```bash
npm install
cp .env.example .env
# Edit .env with TELEGRAM_BOT_TOKEN
npm run dev
```

By default, the bot uses long polling (`TELEGRAM_MODE=polling`), so you can message your bot immediately and see logs in the server output.

## Telegram bootstrap (current milestone)

- Set `TELEGRAM_BOT_TOKEN` in `.env`.
- Set llm-service vars in `.env`: `LLM_SERVICE_BASE_URL`, `LLM_SERVICE_HMAC_SECRET`.
- Optional for context enrichment: `BACKEND_BASE_URL`, `BACKEND_SERVICE_KEY`, `BACKEND_CONTEXT_PATH`.
- Start the server with `npm run dev`.
- Send `/start` to your bot, then any text message.
- The server logs incoming messages (`chatId`, `userId`, `text`) and replies with structured workflow drafts.

## Project structure

Current scaffold aligned to the planned full service:

- `src/index.ts` - composition root and startup flow
- `src/config/` - env parsing and runtime config
- `src/server/` - Fastify app and webhook route wiring
- `src/bot/commands/` - Telegram slash commands
- `src/bot/handlers/` - Telegram event handlers
- `src/services/` - planner/compiler/backend integration modules (scaffolded)
- `src/planner/` - planner prompt context, schema, and block catalog
- `src/state/` - in-memory stores (session scaffold)
- `src/types/` - shared domain types

## Webhook mode (optional)

For deployed environments (e.g. EigenCompute), set:

- `TELEGRAM_MODE=webhook`
- `APP_BASE_URL=https://your-public-domain`
- optional `TELEGRAM_WEBHOOK_SECRET`

Then the server exposes `POST /telegram/webhook` and auto-registers the webhook URL with Telegram.

## llm-service request flow

- Incoming Telegram text becomes `messages` payload for `POST /v1/chat` on `llm-service`.
- The request is HMAC-signed with `x-timestamp` and `x-signature` (same scheme as backend).
- Required body fields sent: `provider`, `model`, `messages`, `requestId`, `userId` (temperature fixed in code).
- Model selection is fixed in code: prefer `eigencloud-gpt-oss`, then `eigencloud-qwen3`, then fallback `openai-chatgpt`.
- Retry policy: each selected model is retried with exponential backoff before model failover.
- The agent sends planner-specific system context, validates planner output, and returns a structured workflow draft to Telegram.

## Backend context enrichment

- If planner output has missing fields, the agent can request safe user context from backend (`POST BACKEND_CONTEXT_PATH`).
- Only allowlisted fields are injected back into the planner prompt (`userAddress`, `privyUserId`, `telegramChatId`, `preferredChains`, `preferredTokens`, `riskProfile`, `slippageBps`).
- Missing/failed backend context fetch does not break planning; the flow continues without enrichment.

## End-to-end test scenarios

Use these to validate the full path: Telegram → planner → compiler → backend (when configured).

### 1. Price alert workflow

1. Ensure `LLM_SERVICE_BASE_URL` and `LLM_SERVICE_HMAC_SECRET` are set; optionally set `BACKEND_BASE_URL` and `BACKEND_SERVICE_KEY` for execution.
2. Send a message like: **"Alert me on Telegram when ETH crosses $3000"** (or "when ETH price is below 2800").
3. Expect: the bot replies with a draft workflow (e.g. Pyth or Chainlink → IF → Telegram), proposed steps, and the line "Reply /confirm to create & run this as a workflow, or edit your request."
4. If backend is configured: send **/confirm**. Expect: "Workflow created and execution started" with workflow ID and execution ID. Send **/status** to see execution status.
5. If the plan has missing inputs, the bot lists them; answer or rephrase before using /confirm.

### 2. Simple notification workflow

1. Send: **"Send me a summary on Telegram"** or **"Notify me on Telegram when done"**.
2. Expect: a short draft (e.g. Start → Telegram) with steps and the /confirm hint.
3. /confirm creates and runs the workflow; /status reports the latest execution.

These two flows exercise the planner (onchain price + condition vs simple notification), the workflow compiler (START + blocks + edges), and—when backend is set—create/execute/status via the FlowForge API.
