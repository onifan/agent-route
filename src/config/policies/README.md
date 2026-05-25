# Policies

集中存放风险、预算、验证、清理等规则策略。

本模块负责规则默认值，不负责执行任务、调用工具或直接修改 task 状态。

- `budget-policy.js`: 默认 goal/task/worker/browser/verification 预算。
- `browser-tool-policy.js`: browser 工具默认适配器、超时、截图和快照限制。
- `risk-policy.js`: 默认风险分类和升级阈值。
- `runtime-policy.js`: AgentRoute 主流程默认任务数、迭代数和超时。
- `verification-policy.js`: 默认验证置信度阈值和语义质量阈值。
- `human-approval-policy.js`: 默认人工确认边界。
- `unattended-policy.js`: 无人值守风险升级策略。
- `index.js`: 对外统一导出，业务模块通过这里读取 policy。
