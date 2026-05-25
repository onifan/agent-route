# 配置指南

AgentRoute Studio 的配置由 `src/config/loader` 统一加载。业务模块应通过配置加载器读取最终配置，而不是散落地读取默认配置和环境变量。

## 配置来源

加载顺序：

1. 内置默认配置
2. 用户本地配置
3. 请求级覆盖配置
4. 环境变量路径和运行时字段

默认配置位置：

- `src/config/prompts`
- `src/config/models`
- `src/config/policies`

用户配置默认读取：

- `AGENT_ROUTE_CONFIG`
- 未设置时读取 `AGENT_ROUTE_HOME/agent-route.json`

## 数据和配置路径

- `AGENT_ROUTE_HOME`：AgentRoute 数据目录。默认使用用户 home 下的 `.agent-route-studio`。
- `AGENT_ROUTE_CONFIG`：用户配置文件路径。
- `AGENT_ROUTE_DB`：模型连接数据库路径。
- `AGENT_ROUTE_TASKS`：任务和 goal 存储文件路径，测试中常用于隔离数据。
- `AGENT_ROUTE_MEMORY`：记忆存储文件路径。
- `AGENT_ROUTE_OBSERVABILITY`：可观测性事件存储文件路径。
- `AGENT_ROUTE_TMP`：工具临时文件目录。
- `AGENT_ROUTE_ARTIFACTS`：artifact 记录文件路径。
- `AGENT_ROUTE_BUDGET_RECORDS`：预算记录文件路径。
- `AGENT_ROUTE_RISK_RECORDS`：风险记录文件路径。
- `AGENT_ROUTE_VERIFICATION_RECORDS`：验证记录文件路径。
- `AGENT_ROUTE_MODEL_STATS`：模型统计记录文件路径。
- `AGENT_ROUTE_ACTION_LEARNING`：行为学习记录文件路径。
- `AGENT_ROUTE_DECISION_ATTRIBUTION`：决策归因记录文件路径。

不要硬编码本机路径。测试中建议通过 `AGENT_ROUTE_HOME` 指向临时目录。

## 最小内部模型配置

使用自定义 OpenAI 兼容上游作为 agent 内部模型服务：

```bash
export AGENT_ROUTE_UPSTREAM_CHAT_URL="https://your-openai-compatible-endpoint/v1/chat/completions"
export AGENT_ROUTE_UPSTREAM_API_KEY="<your-upstream-api-key>"
npm run dev
```

然后从 `/agent-route` 创建目标，或通过 agent action API 提交目标：

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "读取当前仓库并总结 agent 主流程。不要修改文件。"
  }'
```

公开 `/v1/chat/completions` 和 `/v1/responses` 兼容入口已关闭，不再用于对外提供模型代理服务。

不要提交真实 API key。`.env` 和 `.env.*` 应保持未提交。

## 内部模型调用相关变量

agent 内部模型调用可以读取这些变量：

- `AGENT_ROUTE_UPSTREAM_CHAT_URL`
- `AGENT_ROUTE_MODEL_PROXY_URL`：历史兼容变量，仍可作为 chat upstream URL 读取；新配置优先使用 `AGENT_ROUTE_UPSTREAM_CHAT_URL`。
- `AGENT_ROUTE_UPSTREAM_RESPONSES_URL`
- `AGENT_ROUTE_UPSTREAM_API_KEY`
- `AGENT_ROUTE_UPSTREAM_FORWARD_AUTH`
- `AGENT_ROUTE_PUBLIC_URL`
- `OPENROUTER_API_KEY`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`
- `OPENAI_CHAT_COMPLETIONS_URL`
- `GEMINI_OPENAI_CHAT_URL`
- `OC_CHAT_COMPLETIONS_URL`
- `AGENT_ROUTE_OC_CHAT_URL`
- `OC_API_KEY`
- `AGENT_ROUTE_OC_API_KEY`

这些变量只应存在于本机环境、部署平台 secret 或未提交的 `.env` 文件中。

## CORS 和局域网访问

CORS 由 `src/security/cors.js` 集中处理。

- `AGENT_ROUTE_ALLOWED_ORIGINS`：允许跨域访问的 origin 列表，用逗号分隔。
- `AGENT_ROUTE_ALLOW_LAN_DEV=1`：显式允许 Next dev server 的局域网 dev origins。

默认只允许本地开发 origin，例如 `localhost`、`127.0.0.1` 和 `[::1]`。

如果局域网内其他电脑无法打开开发服务，通常需要：

```bash
AGENT_ROUTE_ALLOW_LAN_DEV=1 npm run dev -- --hostname 0.0.0.0
```

同时确认系统防火墙允许端口 `20128`。

生产环境不应默认 `Access-Control-Allow-Origin: *`。需要通过 `AGENT_ROUTE_ALLOWED_ORIGINS` 明确配置允许的 origin。

## 配置状态 API

查看当前生效的脱敏配置：

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{
    "action": "config_status"
  }'
```

返回内容会隐藏 key、token、cookie、password、secret、authorization header 等敏感字段。

## 配置校验

配置加载器会做基础校验：

- prompt settings 必须包含必要字段。
- model pools 必须包含核心池或可 fallback。
- budget policy 数值不能为负。
- risk level 必须合法。
- verification confidence threshold 必须在合理范围内。
- human approval action list 必须是可解析列表。
- unattended policy 不应影响普通非自主运行上下文。

非法配置在测试环境中应暴露明确错误；运行环境中会尽量 fallback 到默认配置并记录 warning。
