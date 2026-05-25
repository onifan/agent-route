# Repositories

负责数据访问封装，为 goal、task、memory、event、artifact 等模块提供持久化接口。

不承载业务决策、任务状态机、风险判断、验证判断或模型调用。

当前第一版底层仍使用现有 JSON store：

- `agent-route-tasks.json`: goal、task、task history、strategy、budget/risk/verification 摘要。
- `agent-route-memory.json`: 长期 memory。
- `agent-route-observability.json`: 系统级 event bus / observability 事件。
- `agent-route-artifacts.json` 等轻量记录文件：artifact、budget、risk、verification、model stats。

路径统一通过 `AGENT_ROUTE_HOME` / `agentRoutePath` 解析，避免业务模块硬编码用户目录。未来迁移 SQLite 或 Postgres 时，业务模块应继续依赖 repository 接口而不是底层文件结构。
