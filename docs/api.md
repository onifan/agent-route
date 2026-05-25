# API 参考

所有端点在 `runtime = "nodejs"`、`dynamic = "force-dynamic"` 下运行，默认端口 `20128`，受 CORS 与本地请求鉴权约束（见 [安全设计](security.md)）。

## 目标运行：`/api/agent-route/ui-stream`

运行目标的**唯一入口**。`POST` 一个含 `messages` 的请求体，返回 Vercel AI SDK 的 UIMessage 流。内部进入 LangGraph runner（`validate_request → prepare_run → execute_goal → complete_run`），通过流持续推送事件。

```bash
curl -N -X POST http://localhost:20128/api/agent-route/ui-stream \
  -H "Content-Type: application/json" \
  -d '{ "messages": [{ "role": "user", "content": "分析这个仓库的执行流程，不要修改文件。" }] }'
```

请求体可带的字段（节选）：`messages`、`goal_id` / `goalId`（恢复已有目标）、以及覆盖 `maxTasks`、`maxGoalIterations`、`budget`、模型池等运行配置的字段。

流中常见事件类型：`start`、`strategy`、`memory`、`plan`、`graph`、`budget`、`langgraph`（节点状态）、任务级别事件、`goal_check`、`pause`（blocked / waiting_human）、`final`。

> 注意：若请求体里带的是 `action` 字段（见下），该端点会转交给 action 处理逻辑，而不是跑目标流。

## Action API：`/api/agent-route/run`

旧的 SSE 目标流已禁用——直接 `POST` 目标会返回 `410 agent_route_legacy_sse_disabled`。该端点现在只处理带 `action` 字段的控制 / 查询调用，返回 JSON。

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{ "action": "config_status" }'
```

> Action 调用也可发往 `/api/agent-route/ui-stream`，两个端点都会先检查 `action` 字段。

支持的 action（同义词以 `/` 分隔，按用途分组）：

### 配置与运行时

`config_status` / `runtime_config` / `get_config` · `recovery_status` / `runtime_recovery_status` · `run_recovery` / `runtime_recovery` / `recover_runtime`

### Provider 管理

`provider_status` / `providers` / `list_providers` · `save_provider` / `upsert_provider` · `delete_provider` / `remove_provider` · `test_provider` / `test_provider_connection` · `save_provider_node` / `upsert_provider_node` · `delete_provider_node` / `remove_provider_node`

### 目标与任务

`list_goals` / `goals` · `list_tasks` / `tasks` · `get_task` / `task_status` · `get_task_history` / `task_history` · `ready_tasks` · `add_tasks` / `register_tasks` · `execute_next` / `execute_next_task` · `continue_task` · `delete_task` / `remove_task`

### 人工确认（任务闸门）

`approve_task` / `confirm_task` · `reject_task` / `deny_task` · `cancel_task`

### 依赖图

`task_graph` / `dependency_graph` / `graph_status`

### 策略

`generate_strategy` / `create_strategy` · `get_strategy` · `strategy_status` / `strategies` · `strategy_history` · `evaluate_strategy` · `revise_strategy` / `replan_strategy` · `invalidate_strategy` · `constrain_plan` · `retry_scope`

### 预算

`budget_status` / `budgets` / `list_budget` · `budget_history` · `evaluate_budget`

### 风险

`risks` / `list_risk` · `risk_history` · `evaluate_risk`

### 验证与真实性

`verifications` / `list_verification` · `verification_history` · `verify_result` · `evaluate_verification` · `authenticity` / `authenticity_status` · `false_success_status`

### 纠正、决策与学习

`corrective_actions` / `corrective_status` · `recommended_actions` / `ranked_actions` / `action_ranking` · `action_decision_status` · `action_learning` / `action_learning_status` / `learning_status` · `decision_attribution` / `attribution_status` / `decision_attribution_status`

### 记忆

`list_memories` / `memories` / `search_memories` · `get_memory` · `add_memory` / `create_memory` · `update_memory` · `delete_memory` · `disable_memory` · `mark_memory_important` · `stale_memory`

### 可观测性与监控

`observability_status` / `monitoring_status` / `monitoring` · `observability_stream` / `monitor_stream` / `event_stream` · `goal_dashboard` · `task_timeline` · `event_timeline` · `risk_monitor` · `budget_monitor` · `verification_monitor` · `worker_health` · `strategy_analytics` · `dependency_monitor` · `diagnostics` · `trace` · `clear_logs` / `clear_events` / `clear_observability` / `reset_monitor` / `reset_monitoring`

## MCP 端点：`/api/mcp`

标准 Model Context Protocol，使用 WebStandard Streamable HTTP transport，支持 `GET` / `POST` / `DELETE` / `OPTIONS`。server 名为 `agent-route-studio`。只暴露安全的控制面能力：

**Tools（9 个）：**

```text
agentroute.create_goal       创建并运行一个目标
agentroute.resume_goal       准备恢复一个目标
agentroute.confirm_task      批准等待人工确认的任务
agentroute.reject_task       拒绝并取消等待确认的任务
agentroute.cancel_task       取消任务
agentroute.get_task          读取任务及其状态历史
agentroute.get_graph         读取目标依赖图与 ready 任务视图
agentroute.get_observability 读取监控 / 诊断 / 事件时间线 / 健康信息
agentroute.search_memories   搜索长期记忆
```

**Resources（5 个，只读 JSON）：**

```text
agentroute://goals/{goalId}
agentroute://tasks/{goalId}/{taskId}
agentroute://graph/{goalId}
agentroute://events/{goalId}
agentroute://artifacts/{artifactId}
```

**Prompts（5 个）：** `agentroute.planner`、`agentroute.worker`、`agentroute.verifier`、`agentroute.reviewer`、`agentroute.finalizer`。

MCP **不**暴露 shell、browser、files、web、codex-cli 等写入型工具；危险动作仍需经过风险、预算、验证与人工确认闸门。

## Provider / 模型 / 设置 REST 端点

| 端点                                                            | 方法               | 说明                         |
| --------------------------------------------------------------- | ------------------ | ---------------------------- |
| `/api/providers`                                                | GET / POST         | 列出 / 新增 provider 连接    |
| `/api/providers/[id]`                                           | GET / PUT / DELETE | 单个 provider                |
| `/api/providers/[id]/models`                                    | ——                 | provider 的模型列表          |
| `/api/providers/[id]/test` · `/test-models`                     | ——                 | 连接 / 模型测试              |
| `/api/providers/validate` · `/test-batch` · `/suggested-models` | ——                 | 校验、批量测试、建议模型     |
| `/api/providers/kilo/free-models`                               | ——                 | 免费模型列表                 |
| `/api/provider-nodes` · `/[id]` · `/validate`                   | ——                 | provider 节点管理            |
| `/api/oauth/[provider]/[action]`                                | ——                 | provider OAuth 流程          |
| `/api/models/alias` · `/availability` · `/disabled` · `/test`   | ——                 | 模型别名、可用性、禁用、测试 |
| `/api/settings`                                                 | ——                 | 运行设置                     |

## 已禁用的公开兼容入口

`/api/v1/chat/completions`、`/api/v1/responses`（以及 rewrite 过来的 `/v1/*`）一律返回 `404 external_compatible_api_disabled`：

```json
{
  "error": {
    "message": "The public OpenAI-compatible API is disabled. Use /api/agent-route/ui-stream for AgentRoute goals.",
    "type": "not_found",
    "code": "external_compatible_api_disabled"
  }
}
```

Agent 内部模型调用不作为公开代理产品对外提供。
