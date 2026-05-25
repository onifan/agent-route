# API 参考

AgentRoute Studio 只暴露一个主要业务 API：

1. Goal-driven Agent action API：`/api/agent-route/run`

公开 OpenAI 兼容模型代理入口已经关闭。`/v1/chat/completions`、`/v1/responses`、`/api/v1/chat/completions` 和 `/api/v1/responses` 不再作为产品能力对外提供。

## AgentRoute action API

```text
POST /api/agent-route/run
OPTIONS /api/agent-route/run
```

这个入口处理目标驱动 agent action。agent 内部需要调用模型时，会通过内部模型服务调用已配置的 provider；该内部能力不作为公开代理 API 暴露。

### 查询配置状态

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{
    "action": "config_status"
  }'
```

### 查询恢复状态

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{
    "action": "recovery_status"
  }'
```

### 手动运行恢复扫描

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{
    "action": "run_recovery"
  }'
```

### 运行普通目标

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "读取一个公开网页并总结。不要登录、不要提交、不要付款；如果工具不可用，请按真实失败说明原因。"
  }'
```

## 常见 AgentRoute action

- `config_status`：查看脱敏后的运行配置。
- `recovery_status`：查看运行恢复摘要。
- `run_recovery`：手动触发恢复扫描。
- `list_goals`：查看目标列表。
- `list_tasks`：查看任务列表。
- `observability_status`：查看运行监控状态。
- `clear_logs`：清除事件和日志记录。
- `reset_monitor`：重置监控中心状态。
- `search_memories`：查询长期记忆。
- `get_task`：查看任务详情。
- `task_history`：查看任务状态历史。
- `risk_history`：查看风险记录。
- `verification_history`：查看验证记录。
- `authenticity_status`：查看真实性判断。
- `corrective_status`：查看纠正动作建议。
- `action_decision_status`：查看建议动作排序。
- `action_learning_status`：查看行为经验统计。
- `decision_attribution_status`：查看决策归因。
- `budget_status`：查看预算记录。
- `graph_status`：查看任务执行图。
- `strategy_status`：查看战略状态。
- `confirm_task`：批准等待人工确认的任务。
- `reject_task`：拒绝任务。
- `cancel_task`：取消任务。
- `delete_task`：删除任务。
- `execute_next_task`：使用调用方提供的 `worker_result` 应用下一个 ready task 的结果；不会再执行占位 worker。

## 已关闭的公开 OpenAI 兼容入口

```text
POST /v1/chat/completions
POST /v1/responses
POST /api/v1/chat/completions
POST /api/v1/responses
```

`next.config.mjs` 仍会把 `/v1/*` rewrite 到 `/api/v1/*`，但这些路由只返回关闭响应：

```json
{
  "error": {
    "message": "The public OpenAI-compatible API is disabled. Use /api/agent-route/run for AgentRoute goals.",
    "type": "not_found",
    "code": "external_compatible_api_disabled"
  }
}
```

这些入口返回 `404`。这是有意设计：AgentRoute Studio 不再表现为公开模型代理产品。

内部模型服务位于 `src/core/router`，由 `handleInternalModelRequest` 调用。它仍保持和 agent 业务状态解耦，不直接依赖 goal、task、memory、risk、verification、budget 或 orchestrator。

如果上游模型服务需要认证，请通过环境变量或供应商设置页面配置 key，不要在代码、README 或请求示例里写真实值。

## 事件和监控相关 API

运行监控主要通过 `observability_status` 和 `observability_stream` 获取。

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{
    "action": "observability_status",
    "limit": 100
  }'
```

事件类型包括但不限于：

- `TaskCompleted`
- `VerificationFailed`
- `BudgetExceeded`
- `RiskEscalated`
- `HumanApproved`
- `DependencySatisfied`
- `StrategyRevised`
- `RecoveryStarted`
- `TaskRecovered`
- `GoalRecovered`
- `WorkerLostDetected`
- `BrowserSessionMarkedStale`
- `RecoveryCompleted`
- `AuthenticityChecked`
- `CorrectiveActionSuggested`
- `ActionRanked`
- `ActionLearningUpdated`
- `DecisionAttributed`

## 人工确认相关 API

批准任务：

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{
    "action": "confirm_task",
    "task_id": "task-id"
  }'
```

拒绝任务：

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{
    "action": "reject_task",
    "task_id": "task-id",
    "reason": "Not approved by user"
  }'
```

这些 action 不应被前端用来绕过风险系统。高风险动作是否可以继续，应以后端 risk/approval 状态为准。
