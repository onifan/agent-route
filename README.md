# AgentRoute Studio

**A local-first, goal-driven AI agent console with internal provider routing.**

AgentRoute Studio turns a natural language goal into an observable, recoverable, and auditable execution loop — covering strategy, task decomposition, tool execution, evidence collection, result verification, risk monitoring, budget control, and learning from failures.

This is not a chat interface, a public model proxy, or a platform automation script. It is an autonomous agent workbench: the agent uses an internal model service to call configured providers, while goal execution stays constrained by risk gates, a verification layer, a budget system, and human approval for high-stakes actions.

> **Current status:** Suitable for local development, research, low-risk automation, and agent runtime experimentation. Any action involving real accounts, payments, form submissions, production changes, or sensitive data must go through human confirmation and audit.

---

## Screenshots

![Task Queue](docs/screenshots/task-queue.png)
![Execution Graph](docs/screenshots/execution-graph.png)
![Control Center](docs/screenshots/control-center.png)

---

## Core Capabilities

- **Internal model provider routing** — Agent-only model calls through configured OpenAI-compatible providers, OAuth-backed providers, or custom upstreams. Public `/v1/*` compatible API endpoints are disabled.
- **Goal-driven agent** — Takes a natural language goal and generates a strategy, task graph, worker execution, evidence, verification, review, and final synthesis.
- **Task state machine and execution graph** — Centralized task lifecycle management with dependency-based readiness checks.
- **Risk system** — Deterministic risk gates before shell, file, browser, and codex-cli tool execution. High-risk actions require explicit approval.
- **Verification and authenticity detection** — Worker success does not equal task completion. The system validates evidence and detects duplicates, empty links, placeholder content, and fake successes.
- **Budget and resource monitoring** — Tracks tokens, cost, runtime, retries, browser actions, and degradation state to prevent infinite loops.
- **Memory, corrective actions, and learning** — Records failure reasons, suggested actions, historical success rates, and user overrides to improve future decisions.
- **Runtime monitoring and recovery** — Provides event streams, task timelines, risk/budget/verification dashboards, and safe recovery summaries after restarts.

---

## Safety Boundaries

By default, the system will not automatically:

- Log into real accounts
- Bypass CAPTCHAs or platform anti-bot systems
- Submit proposals, forms, orders, or payments
- Send real messages
- Upload sensitive files
- Execute production environment changes
- Delete important data
- Read credential files or secret directories

When any of the above actions are detected, the risk system returns a structured blocked result and requires human confirmation. See [Security Design](docs/security.md) for details.

---

## Architecture

```
User Goal → Strategy → Task Graph → Budget & Risk Gates
         → Worker / Tools → Evidence → Verification
         → Authenticity Check → Review → Final Answer
                            ↓
                     Events & Monitoring
                            ↓
                  Corrective Actions → Decision Ranking & Learning
```

| Layer                  | Location          | Purpose                                                                                   |
| ---------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| Internal model service | `src/core/router` | Agent-only provider adaptation, connection rotation, failover, and response compatibility |
| Goal-driven agent      | `src/agent`       | Goal decomposition, task execution, risk, verification, budget, memory                    |
| Frontend workbench     | `app/agent-route` | Run, observe, confirm, and debug agent flows                                              |
| Config and policy      | `src/config`      | Default prompts, model pool, risk/budget/verification strategy                            |
| Tool execution         | `src/tools`       | Structured execution of codex-cli, browser, shell, and file tools                         |
| Storage                | `src/storage`     | Data access for goals, tasks, events, memory, and artifacts                               |
| Security and CORS      | `src/security`    | CORS, API key utilities, tool risk gates                                                  |

---

## Quick Start

**Requirements:** Node.js `>=22`, npm, macOS or Linux

```bash
npm install
npm run dev
```

Default port is `20128`. Open: http://localhost:20128/agent-route

**Production build:**

```bash
npm run build
npm run start:production
```

---

## Minimal Internal Model Setup

Configure a provider for agent commander, planner, worker, reviewer, and finalizer calls:

```bash
export AGENT_ROUTE_UPSTREAM_CHAT_URL="https://your-openai-compatible-endpoint/v1/chat/completions"
export AGENT_ROUTE_UPSTREAM_API_KEY="<your-api-key>"
npm run dev
```

Then use the AgentRoute workbench or submit a goal through the agent action API:

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "Analyze this repository and explain the current agent execution flow. Do not modify files."
  }'
```

The OpenAI-compatible public endpoints such as `/v1/chat/completions` and `/v1/responses` intentionally return disabled responses. Agent internal model calls are not exposed as a public proxy product.

Do not commit real API keys. See [Configuration Guide](docs/configuration.md) for all environment variables.

---

## API Examples

```bash
# Check config status
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{ "action": "config_status" }'

# Check recovery status
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{ "action": "recovery_status" }'

```

See [API Reference](docs/api.md) for the full list of actions and endpoints.

---

## Common Commands

```bash
npm run format        # Format source code with Prettier
npm run format:check  # Check formatting without writing
npm run lint          # Run ESLint
npm test              # Run all tests
npm run build         # Next.js build + project structure validation
```

---

## Pages

| Page            | URL            | Description                                        |
| --------------- | -------------- | -------------------------------------------------- |
| Control center  | `/agent-route` | Create and run goals                               |
| Runtime monitor | `/agent-route` | Event stream, budget, risk, verification, recovery |

---

## Documentation

- [Architecture](docs/architecture.md) — Directory structure, module boundaries, execution flow
- [Configuration](docs/configuration.md) — Environment variables, internal model providers, CORS, data directory
- [API Reference](docs/api.md) — All actions, endpoints, curl examples
- [Security Design](docs/security.md) — Risk gates, safety boundaries, sensitive data handling
- [Development & Ops](docs/development.md) — Commands, testing, recovery, troubleshooting

---

## Pre-commit Checklist

```bash
npm run format:check
npm run lint
npm test
npm run build
```

Also verify:

- No `.env` or real API keys committed
- No `.next`, standalone build artifacts, or generated `server.js` at root
- No logs, databases, caches, temp directories, or screenshots with private paths
- No high-risk actions bypassing the risk gate
- No security decisions re-derived on the frontend

---

## Stack

Next.js · Node.js · TypeScript · React · OpenAI-compatible provider APIs · REST APIs
