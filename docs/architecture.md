# 架构说明

AgentRoute Studio 以目标驱动 Agent 为核心。系统刻意拆成两套互不依赖的子系统：

1. **Agent 内部模型服务**（`src/core`）：负责 provider 适配、连接轮询、failover、上游调用和响应格式兼容。只供 commander、planner、worker、verifier、reviewer、finalizer 等内部角色使用，不对外提供模型代理产品。
2. **目标驱动 Agent**（`src/agent`，约 90 个源文件）：负责 goal、strategy、task graph、worker、risk、verification、budget、memory、observability、recovery、corrective 与学习。

关键边界：内部模型服务不应依赖 goal、task、memory、risk、verification、budget 或 orchestrator。公开 `/v1/*` OpenAI 兼容入口已关闭，只返回 disabled 响应。

## 顶层目录

```text
app/
  agent-route/                 # 前端工作台（控制台 + 运行监控）
    chat/                      # 聊天式运行视图
  dashboard/                   # provider 配置后台、legacy 重定向
  callback/                    # OAuth 回调页
  api/
    agent-route/ui-stream/     # 目标运行主入口（UIMessage 流）
    agent-route/run/           # action API（旧 SSE 目标流已禁用，返回 410）
    mcp/                       # 对外 MCP Streamable HTTP 端点
    providers/ provider-nodes/ # provider 连接与节点管理
    oauth/[provider]/[action]/ # provider OAuth 流程
    models/                    # 模型别名、可用性、测试、禁用
    settings/                  # 运行设置
    v1/chat/completions/       # 已禁用的公开兼容入口（404）
    v1/responses/              # 已禁用的公开兼容入口（404）
  v1/                          # rewrite 到 /api/v1/*，同样返回禁用响应

src/
  core/        # Agent 内部模型服务（router / providers / oauth / model catalog）
  agent/       # 目标驱动智能体系统
  config/      # 默认配置、策略、加载器
  tools/       # web / browser / shell / files / documents / codex-cli 工具层
  storage/     # repository 层（基于 JSON store，可选 SQLite）
  security/    # CORS、请求鉴权、确定性风险闸门
  shared/      # 公共类型、工具、常量、hooks
  store/       # 前端状态
  mitm/        # 可选的本地 HTTPS 拦截代理（打包后的 server.js）
  lib/updater/ # 应用自更新辅助

scripts/
  build.js              # next build 后的项目结构与语法校验
  start-production.js   # 生产 standalone 启动入口（默认绑定 127.0.0.1）
  create-api-key.js     # 生成本地 API key
```

## Agent 内部模型服务（`src/core`）

位置：`src/core/router`、`src/core/providers`、`src/config/models`。

职责：

- 接收 Agent 内部模型请求，路由到上游模型服务。
- 支持 OpenAI 兼容 provider 调用，以及必要的 responses 兼容。
- 处理 provider 配置、模型能力标签、连接轮询、failover 和响应格式兼容。
- `src/core/router/runtime.js` 内置了一组 OpenAI 兼容上游目标（OpenRouter、OpenAI、Gemini、DeepSeek、Kimi/Moonshot、GLM/智谱等），并按模型前缀（如 `openrouter/`、`gemini/`、`gc/`、`oc/`）路由。

不负责：goal/task 生命周期、记忆、风险、验证、预算、工具执行。

## 目标驱动 Agent（`src/agent`）

主要模块（目录）：

- `strategies`：策略生成、成功标准、约束、风险边界、预算边界、停止条件和策略修订。
- `tasks`：单个任务的生命周期和状态机（`TASK_STATUS`）。
- `graph`：任务执行图、依赖关系、ready task、循环检测和下游阻塞传播。
- `memory`：长期记忆写入、检索、更新、失效和上下文注入。
- `risk`：风险判定、风险升级、人工确认、危险命令和危险浏览器动作识别。
- `verification`：验证任务是否真的成功，含文件意图（`file-intent`）、shell、browser、API、语义验证。
- `verification/authenticity`：真实性检测，识别重复、空链接、占位符、伪造成功等。
- `budget`：token、成本、重试、运行时间、浏览器动作和模型降级控制（`governor`）。
- `evidence`：worker / browser 证据统一化与脱敏。
- `observability`：目标监控、任务时间线、事件时间线、预算 / 风险 / 验证 / 执行器健康度和诊断。
- `recovery`：运行恢复，处理重启后 running task、worker lost、stale browser session 等。
- `corrective`：根据 verification / authenticity / risk 生成建议动作。
- `action-decision`：对建议动作评分和排序。
- `action-learning`：统计动作历史成功率、成本和耗时。
- `decision-attribution`：记录系统推荐、用户覆盖、人工介入和 fallback 的结果归因。
- `mcp`：标准 Model Context Protocol server / client（见下文 MCP 边界）。
- `orchestrator`：把整个目标驱动流程串起来（见下文执行流程）。

## 目标执行流程

运行入口与编排相关文件：

```text
app/api/agent-route/ui-stream/route.js   # HTTP 入口
src/agent/orchestrator/runtime.js        # 核心循环 runAgentRouteEvents
src/agent/orchestrator/langgraph-runner.js # LangGraph 包装
```

`POST /api/agent-route/ui-stream` → `handleAgentRouteUiStream` → `langGraphRunner.runAgentRouteLangGraph`，把核心业务循环包在 LangGraph `StateGraph` 的四个节点里：

- `validate_request`
- `prepare_run`
- `execute_goal`
- `complete_run`

每个节点都会通过 UIMessage 流发布一个 `langgraph` 事件，包含 `node`、`status`、`elapsedMs`、`graph` 和错误摘要。项目**不提供**关闭 LangGraph 或回退到旧过程式入口的配置；图构建、节点校验、节点执行或下游 worker 失败时，错误会作为 UIMessage stream 的 error part 直接返回前端，失败事件仅用于观测，随后重新抛出原错误。

核心循环 `runAgentRouteEvents`（在 `runtime.js` 内）本身只做编排与发事件，重活委托给 `orchestrator/` 下的子模块。一次目标运行大致如下：

```text
Goal
 └─ goalSetup.createRunState   建运行状态、载入记忆、准备 budget / strategy
     └─ initialPlanning        commander 生成初始任务（resume 时从 store 读回）
         └─ for iteration ≤ maxGoalIterations:
              loopController.evaluateIterationGuards   预算 / 策略停止判定
              taskExecutor.drainReadyTasks             跑依赖图上 ready 的任务
                  └─ runWorkerTask:
                       taskGates.handleStartGate              风险 / 预算闸门
                       workerDispatcher.dispatchWorker        分派 worker
                       workerResultProcessor                  规范化、记账
                       taskVerificationStep.verifyWorkerResultIfNeeded  验证层
                       taskStateUpdater.applyWorkerResultAndPublish     更新状态、发事件
              reviewRunner.runReviewIteration          复盘：给最终答案 / 追加任务 / 继续
         └─ finalBlockedByUnresolvedPlannedTasks   计划内任务未解决则不许出最终答案
         └─ blockedWhenNoSuccessfulWorkerEvidence   无成功证据则 blocked
         └─ finalizer.runFinalSynthesis             合成最终答案
```

任务、预算、策略状态通过 `taskRuntime`（即 `src/agent/tasks`）与各 repository 落库。

### 关键原则

- worker 不能直接把任务宣布完成；task completed 必须经过 verification。
- high 或 critical 风险任务未批准时不能执行工具。
- budget 可以阻止 retry、暂停任务或触发模型降级。
- strategy 高于单个 task，planner 不应生成违反 strategy 的任务。
- dependency graph 决定哪些 task ready。
- event bus 是监控系统的主要数据源。

## 工具层（`src/tools`）

```text
src/tools/web        # 公网读取（fetch / curl，受私网地址风险闸门约束）
src/tools/browser    # Playwright 浏览器（含 mock adapter、截图、快照、会话管理）
src/tools/shell      # shell 命令执行
src/tools/files      # 文件读写、哈希、临时文件
src/tools/documents  # 文档渲染
src/tools/codex-cli  # codex-cli 运行器（临时工作区、日志过滤、结果解析）
```

工具层只负责执行外部动作并返回结构化结果（`ok` / `action` / `stdout` / `stderr` / `exitCode` / `path` / `size` / `hash` / `url` / `title` / `textPreview` / `screenshotPath` / `snapshotPath` / `durationMs` / `metadata`）。

工具层**不**判断业务风险、不更新 task 状态、不写 memory、不登记业务 artifact、不判断任务是否完成——这些由 agent 模块处理。

## MCP 边界

```text
src/agent/mcp/server.js   # 对外 MCP server（WebStandard Streamable HTTP transport）
src/agent/mcp/client.js   # 进程内 worker MCP client（InMemoryTransport）
app/api/mcp/route.js      # /api/mcp 端点
```

对外 `/api/mcp` 使用标准 Streamable HTTP transport，server 名为 `agent-route-studio`，只暴露安全的控制面能力：

- **Tools（9 个）**：`agentroute.create_goal`、`agentroute.resume_goal`、`agentroute.confirm_task`、`agentroute.reject_task`、`agentroute.cancel_task`、`agentroute.get_task`、`agentroute.get_graph`、`agentroute.get_observability`、`agentroute.search_memories`。
- **Resources（5 个）**：`agentroute://goals/{goalId}`、`agentroute://tasks/{goalId}/{taskId}`、`agentroute://graph/{goalId}`、`agentroute://events/{goalId}`、`agentroute://artifacts/{artifactId}`。
- **Prompts（5 个）**：planner、worker、verifier、reviewer、finalizer。

MCP **不**直接暴露 shell、browser、files、web 或 codex-cli 等写入型工具；危险动作仍必须先经过 risk、budget、verification 和人工确认闸门。

内部 worker MCP 边界位于 `src/agent/mcp/client.js`，仅在进程内使用 `InMemoryTransport`，把 worker dispatcher 到 document / web / browser / codex-cli worker 的调用统一为标准 MCP `tools/list`、`tools/call`、`resources/read` 形态；这些 worker tools 不注册到公开 `/api/mcp`。内部 worker 不提供回退到原直接调用路径的配置；协议或 schema 错误直接暴露为调用失败，工具执行失败则作为 MCP tool result 返回，保留原 worker result 结构供 retry、verification 和 observability 使用。

## 存储层（`src/storage`）

业务模块通过 repository 层访问数据，底层默认使用 JSON runtime store，可选 `better-sqlite3` 持久化。仓库包括：`goal-repository`、`task-repository`、`task-event-repository`、`memory-repository`、`strategy-repository`、`artifact-repository`、`event-repository`、`budget-repository`、`risk-repository`、`verification-repository`、`model-stats-repository`。

`storage/repositories` 不反向依赖 orchestrator。

## 配置层（`src/config`）

- `prompts`：默认 prompt settings。
- `models`：默认模型池、模型等级（commander / strong / coding / free / codex-cli，等级标签 L0–L3 / local）、能力与成本信息。
- `policies`：runtime、budget、risk、verification、human-approval、unattended、recovery、browser-tool 策略。
- `loader`：合并默认配置、用户配置文件（`agent-route.json`）、请求覆盖，执行校验和脱敏。

`config/loader` 不依赖 agent / orchestrator，避免循环依赖。

## 前端（`app/agent-route`）

前端工作台负责展示和触发操作，不承担核心业务判断。任务是否 blocked、是否 waiting human、风险高低、验证是否通过，都由后端模块决定，前端只展示结构化结果和建议操作。

## 模块边界清单

- `core/router` 不依赖 `src/agent`。
- `agent/orchestrator` 做流程编排，不塞底层工具细节。
- `agent/tasks` 统一管理任务状态变化。
- `agent/risk` 与 `security/tool-risk-gate` 负责风险与人工确认。
- `agent/verification` 负责验证真实完成。
- `agent/evidence` 负责证据统一与脱敏。
- `tools/*` 不写 memory、不改 task、不登记业务 artifact。
- `storage/repositories` 不反向依赖 orchestrator。
- `config/loader` 不依赖 agent / orchestrator。
