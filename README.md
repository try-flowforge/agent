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
# Edit .env with your values
npm run dev
```

For production, the service is containerized and intended for deployment (e.g. EigenCompute) with a public webhook URL for Telegram.
