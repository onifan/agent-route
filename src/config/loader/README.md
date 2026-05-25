# Config Loader

统一加载 AgentRoute 运行配置。

- 负责：读取内置默认配置、读取用户本地覆盖、合并配置、基础校验、补齐默认值、脱敏后供 dashboard/API 展示。
- 不负责：执行 agent 业务逻辑、模型调用、风险判断、预算记账或任务状态修改。
- 默认配置来源：`src/config/prompts`、`src/config/models`、`src/config/policies`。
- 用户覆盖：默认读取 `AGENT_ROUTE_CONFIG`，否则读取 `AGENT_ROUTE_HOME/agent-route.json`。文件不存在时静默使用默认配置。
- 路径：统一通过 `shared/utils/agent-home` 解析，避免硬编码用户目录。

业务模块应优先通过 `src/config/loader` 获取最终运行配置，而不是自己读取配置文件或重复合并默认值。
