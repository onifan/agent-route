# Shared

公共类型、工具、错误和常量。

这里不承载业务流程。只有多个模块共同依赖、且不会反向依赖 agent/core 的能力才放入 shared。

- `utils/agent-home.js`: 统一解析 AgentRoute 数据目录，优先读取 `AGENT_ROUTE_HOME`，测试环境可用它隔离写入位置。
