# FlowForge Agent

A service that lets users create and run workflows from natural language. It is an alternative to the web app: users can either use the canvas and web UI, or interact entirely via Telegram.

Built for the EigenCloud Open Innovation Challenge as a verifiable agent - deterministic planning and replay-proof execution.

## What it does

- **Natural language to workflows**: Describe what you want in plain language; the agent turns it into a workflow and can run it for you.
- **Telegram-first**: Two commands drive the full flow: `/plan` to draft steps/providers and `/execute` to run either the saved draft or a prompt passed inline.
- **Identity via web bootstrap**: One-time link from Telegram to a minimal web page for Privy login and Safe wallet setup; after that, everything happens in Telegram.
- **Verifiable**: Planning uses deterministic inference; execution and proofs are designed for the EigenCloud verifiability story.

## Commands

| Command | Purpose |
| ------- | ------- |
| `/plan <prompt>` | Draft workflow steps and providers from your natural-language request |
| `/execute [prompt]` | Execute the previously discussed plan, or execute directly from a new prompt |

## Requirements

- Node.js 20+
- Environment variables (see `.env.example`): **Required:** `LLM_SERVICE_BASE_URL`, `LLM_SERVICE_HMAC_SECRET`. **Optional:** `TELEGRAM_BOT_TOKEN` (if unset, only the uniform API runs), backend URL and service key for execute and context.

## Run locally

```bash
npm install
cp .env.example .env
# Required: set LLM_SERVICE_BASE_URL, LLM_SERVICE_HMAC_SECRET
# Optional: TELEGRAM_BOT_TOKEN for Telegram; BACKEND_SERVICE_KEY (and BACKEND_BASE_URL) for uniform API auth and execute
npm run dev
```

- With `TELEGRAM_BOT_TOKEN` set, the bot uses long polling by default (`TELEGRAM_MODE=polling`); you can message the bot and see logs in the server output.
- Without `TELEGRAM_BOT_TOKEN`, the server still starts and exposes **POST /v1/plan** and **POST /v1/execute** (uniform API). Use `X-Service-Key` (same as `BACKEND_SERVICE_KEY`) and `X-On-Behalf-Of` (userId) to call them.

## Testing the implementation

1. **Backend**: Run migrations (includes `051_create_agent_user_context_table`). Ensure `AGENT_SERVICE_KEY` is set (agent uses this as `BACKEND_SERVICE_KEY` for auth).
2. **LLM service**: Running and reachable at `LLM_SERVICE_BASE_URL`.
3. **Agent**:
   - **Telegram**: Set `TELEGRAM_BOT_TOKEN`, `BACKEND_BASE_URL`, `BACKEND_SERVICE_KEY`. Start with `npm run dev`; use `/plan` and `/execute` in the bot.
   - **Uniform API only**: Leave `TELEGRAM_BOT_TOKEN` unset. Set `BACKEND_SERVICE_KEY` (and `BACKEND_BASE_URL` for execute/context). Start agent; then e.g. `curl -X POST http://localhost:PORT/v1/plan -H "Content-Type: application/json" -H "X-Service-Key: YOUR_KEY" -H "X-On-Behalf-Of: test-user-id" -d '{"prompt":"Get ETH price"}'`.
4. **User context**: Backend exposes `GET/PATCH /api/v1/users/me/agent-context` (Privy auth) to read/update stored agent context; POST /api/v1/agent/context merges that with Telegram link data for the planner.

## Telegram bootstrap (current milestone)

- Set `TELEGRAM_BOT_TOKEN` in `.env`.
- Set llm-service vars in `.env`: `LLM_SERVICE_BASE_URL`, `LLM_SERVICE_HMAC_SECRET`.
- Optional for context enrichment: `BACKEND_BASE_URL`, `BACKEND_SERVICE_KEY`, `BACKEND_CONTEXT_PATH`.
- Start the server with `npm run dev`.
- Send `/plan <prompt>` to your bot to draft a workflow.
- Send `/execute` (or `/execute <prompt>`) to run.

## Project structure

Current scaffold aligned to the planned full service:

- `src/index.ts` - composition root and startup flow
- `src/config/` - env parsing and runtime config
- `src/server/` - Fastify app and webhook route wiring
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

- Incoming `/plan` or `/execute <prompt>` text becomes `messages` payload for `POST /v1/chat` on `llm-service`.
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
2. Send: **`/plan Alert me on Telegram when ETH crosses $3000`** (or "...below 2800").
3. Expect: the bot replies with a draft workflow (e.g. Pyth or Chainlink → IF → Telegram), proposed steps, and a prompt to run `/execute`.
4. If backend is configured: send **`/execute`**. Expect: "Workflow created and execution started" (or scheduled) and follow-up notifications in chat.
5. If the plan has missing inputs, the bot lists them; resend with details via `/plan <updated prompt>` or `/execute <updated prompt>`.

### 2. Simple notification workflow

1. Send: **`/execute Send me a summary on Telegram`** (or `/plan ...` then `/execute`).
2. Expect: direct execution when inputs are complete, otherwise a draft with missing details.
3. Execution updates are posted back in Telegram as the run progresses.

These two flows exercise the planner (onchain price + condition vs simple notification), the workflow compiler (START + blocks + edges), and—when backend is set—create/execute via the FlowForge API.
