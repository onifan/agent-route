# AgentRoute Studio

**A local-first, goal-driven autonomous agent console with an internal model routing service built for agents.**

AgentRoute Studio turns a natural-language goal into an observable, recoverable, and auditable execution loop: strategy generation -> task decomposition -> dependency graph scheduling -> tool execution -> evidence collection -> verification and authenticity checks -> review iterations -> final synthesis. The product includes a goal-oriented chat console, but it is not a public model proxy product. Public OpenAI-compatible `/v1/*` entry points are explicitly disabled; model access is reserved for internal agent roles such as commander, planner, worker, verifier, reviewer, and finalizer.

Four mechanisms govern goal execution: deterministic risk gates, mandatory verification, budget governance, and human confirmation for high-risk actions.

> **Current scope:** Designed for local development, research, low-risk automation, and agent runtime experiments. Actions involving real accounts, payments, form submission, production changes, or sensitive data are stopped by the risk gate and require human confirmation.

---

## Features

- **Internal agent model routing** - Calls model APIs configured in the console for internal model roles. Supported providers are OpenAI, Claude, Gemini, Grok, DeepSeek, Qwen, GLM, and Kimi, each with an API key and optional third-party base URL.
- **Goal-driven agents** - Generates strategies, task graphs, worker executions, evidence, verification, reviews, and final answers from a goal.
- **Task state machine and execution graph** - Centrally manages task lifecycles and calculates readiness from dependencies.
- **Risk system** - Applies deterministic risk evaluation before shell, file, browser, web, and codex-cli tool execution; unapproved high or critical actions do not run.
- **Verification and authenticity checks** - A worker reporting success is not enough to complete a task; the system validates evidence and detects duplicates, empty links, placeholders, and fabricated successes.
- **Budget and resource monitoring** - Tracks tokens, cost, duration, retries, and browser actions to prevent runaway execution.
- **Memory, corrective actions, and learning** - Records failure causes, proposed actions, historical success rates, and user overrides to improve later decisions.
- **Runtime observability and recovery** - Provides event streams, task timelines, budget/risk/verification views, and controlled recovery after restarts.

---

## Technology

Next.js 16 (App Router) | React 19 | Node.js >= 22 | LangGraph (orchestration) | Model Context Protocol SDK (tool protocol) | Vercel AI SDK (chat streaming) | Playwright (browser tools) | Zod | Zustand | optional better-sqlite3 (local persistence)

---

## Quick Start

**Requirements:** Node.js `>=22`, npm, and macOS or Linux.

```bash
npm install
npm run dev
```

The default port is `20128`, and the build output directory is `.next-cli-build` rather than the default `.next`.

Open the console: <http://localhost:20128/agent-route>

**Minimal internal model configuration** for commander, planner, worker, verifier, and finalizer calls:

1. Open <http://localhost:20128/agent-route#model-apis>.
2. Enable the provider you want to use.
3. Set its API key, base URL, default model, and model list.

OpenAI-compatible providers use `/chat/completions`; Claude uses Anthropic Messages and is translated internally. The old provider/OAuth administration flow and generic upstream environment-variable fallback are removed.

**Production build and startup:**

```bash
npm run build            # next build plus structural checks in scripts/build.js
npm run start:production # starts .next-cli-build/standalone/server.js on 127.0.0.1 by default
```

---

## Run a Goal

Goals enter through **`POST /api/agent-route/ui-stream`**, which uses the Vercel AI SDK UIMessage stream. Requests enter the LangGraph runner through four nodes: `validate_request -> prepare_run -> execute_goal -> complete_run`. The event stream continuously emits strategy, plan, graph, budget, task status, verification, and final-answer events.

```bash
curl -N -X POST http://localhost:20128/api/agent-route/ui-stream \
  -H "Content-Type: application/json" \
  -d '{ "messages": [{ "role": "user", "content": "Analyze this repository and explain its current agent execution flow without modifying any files." }] }'
```

`/api/agent-route/run` no longer carries goal streams. Its legacy SSE goal stream is disabled and returns `410`; the endpoint is now reserved for action requests such as `config_status` and `recovery_status`:

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{ "action": "config_status" }'
```

See the [API reference](docs/api.md) for the complete action list, endpoints, and MCP interface.

---

## Commands

```bash
npm run dev              # development mode on port 20128
npm run build            # production build plus structural checks
npm run start:production # start the standalone production service
npm run format           # format with Prettier
npm run format:check     # verify formatting only
npm run lint             # run ESLint
npm test                 # run all tests under src
```

---

## Pages

| Page                      | URL                       | Description                                                                                                       |
| ------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Console / runtime monitor | `/agent-route`            | Create and run goals; inspect the chat event stream, task graph, budget, risk, verification, and recovery summary |
| Model API settings        | `/agent-route#model-apis` | Configure OpenAI, Claude, Gemini, Grok, DeepSeek, Qwen, GLM, and Kimi API keys, base URLs, and model lists        |

---

## Security Boundary

By default, the system does not automatically sign in to real accounts, bypass CAPTCHAs, submit forms, orders, or payments, send real messages, upload local data, change production environments, delete database files, or read sensitive credential directories such as `~/.ssh` and `~/.aws`. When an action matches these categories, the deterministic risk gate returns a structured blocked result and requests human confirmation. See [Security Design](docs/security.md).

---

## Documentation

- [Architecture](docs/architecture.md) - system boundaries, directory structure, LangGraph execution flow, and module inventory
- [Configuration](docs/configuration.md) - environment variables, data directory, default policies, model pools, and ports
- [API Reference](docs/api.md) - execution entry point, complete action API list, MCP endpoint, and REST endpoints
- [Security Design](docs/security.md) - request authentication, CORS, risk-gate rules, and security boundaries
- [Development and Operations](docs/development.md) - commands, tests, build verification, production startup, local API keys, and troubleshooting

---

## Before Committing

```bash
npm run format:check
npm run lint
npm test
npm run build
```

Also verify that:

- No `.env` file or real API key is committed.
- No `.next-cli-build` output or standalone build artifact is committed.
- No logs, databases, caches, temporary directories, or screenshots containing private paths are committed.
- No high-risk action bypasses the risk gate.
- No security decision has been moved back into frontend inference.
