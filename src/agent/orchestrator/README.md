# Orchestrator

负责把目标驱动流程串起来：goal、strategy、task graph、budget、risk、worker、artifact、verification、state update、event、memory。

不直接实现风险规则、验证规则、预算规则或普通模型 provider 代理。旧 `src/agent-route.js` 只聚合这里的目标驱动入口以保持 API 兼容。

当前拆分：

- `planner.js`：规划提示词、baseline plan helper、plan 规范化。
- `worker-runner.js`：worker/verifier 提示词组装。
- `review-loop.js`：review 提示词与 review 结果规范化。
- `finalizer.js`：最终回答综合提示词。
- `codex-cli-runner.js`：本地 Codex CLI 执行与日志过滤。
- `result-normalizer.js`：worker result、risk/budget/verification gate 结果标准化。
- `event-stream.js`：Vercel AI SDK UIMessage stream 事件包装、顺序输出、观测事件记录。
- `action-api.js`：dashboard/API 触发的人工确认、任务管理、监控查询等操作。
- `goal-setup.js`：goal 运行上下文、memory、strategy、budget 初始化。
- `initial-planning.js`：初始规划器调用、planner 结果恢复/规范化、第一批任务追加。
- `langgraph-runner.js`：LangGraph `StateGraph` 运行入口，承载 UIMessage stream 的目标执行路径和节点运行态事件。
- `task-appender.js`：planner/review 任务规范化、战略约束、任务图写入。
- `task-executor.js`：任务摘要、暂停/终态判断、ready task drain 调度。
- `loop-controller.js`：主循环预算/战略停止条件 guard。
- `review-iteration.js`：review 迭代的小型结构化 helper。
- `review-runner.js`：审查模型调用、strategy revision、review memory 和下一批任务建议。
- `finalizer.js`：最终回答提示词与 final synthesis 收尾流程。
- `task-context.js`：单个任务执行前的运行状态与 worker memory/model pool 上下文准备。
- `task-gates.js`：`startTask` 后的风险/预算门禁结果处理。
- `worker-dispatcher.js`：按 task worker 类型分发到 codex-cli 或模型池。
- `worker-result-processor.js`：worker result 标准化与 budget usage 记录。
- `task-verification-step.js`：worker success 后的 verification step 编排。
- `task-state-updater.js`：应用 worker/verification 结果、重试调度、事件与 memory 发布。
