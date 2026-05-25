# 配置指南

配置来自三层，按优先级从低到高合并：默认策略（`src/config`）< 用户配置文件（`agent-route.json`）< 请求体覆盖。合并、校验与脱敏由 `src/config/loader` 完成。

## 数据目录

运行数据写入 AgentRoute 的 home 目录，解析顺序为：

```text
AGENT_ROUTE_HOME  →  DATA_DIR  →  ~/.agent-route-studio
```

默认文件位置（均可用环境变量单独覆盖）：

| 用途                   | 默认路径                                | 覆盖变量                                                                                     |
| ---------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| 用户配置               | `<home>/agent-route.json`               | `AGENT_ROUTE_CONFIG`                                                                         |
| 任务                   | `<home>/tasks.json`                     | `AGENT_ROUTE_TASKS`                                                                          |
| 记忆                   | `<home>/memory.json`                    | `AGENT_ROUTE_MEMORY`                                                                         |
| SQLite 数据库          | `<home>/db/data.sqlite`                 | `AGENT_ROUTE_DB`                                                                             |
| 可观测性记录           | `<home>/agent-route-observability.json` | `AGENT_ROUTE_OBSERVABILITY`                                                                  |
| 预算 / 风险 / 验证记录 | `<home>/...`                            | `AGENT_ROUTE_BUDGET_RECORDS`、`AGENT_ROUTE_RISK_RECORDS`、`AGENT_ROUTE_VERIFICATION_RECORDS` |
| 产物 / 模型统计        | `<home>/...`                            | `AGENT_ROUTE_ARTIFACTS`、`AGENT_ROUTE_MODEL_STATS`                                           |
| 决策归因 / 学习        | `<home>/...`                            | `AGENT_ROUTE_DECISION_ATTRIBUTION`、`AGENT_ROUTE_ACTION_LEARNING`                            |

## 内部模型 provider

Agent 内部模型服务（`src/core/router`）按以下方式确定上游：

**方式一：环境变量直接配置 upstream。**

| 变量                                                 | 说明                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `AGENT_ROUTE_UPSTREAM_CHAT_URL`                      | chat 兼容上游地址（也可用 `AGENT_ROUTE_MODEL_PROXY_URL`）               |
| `AGENT_ROUTE_UPSTREAM_RESPONSES_URL`                 | responses 兼容上游地址（responses 模式）                                |
| `AGENT_ROUTE_UPSTREAM_API_KEY`                       | 上游 API key（以 Bearer 注入）                                          |
| `AGENT_ROUTE_UPSTREAM_FORWARD_AUTH`                  | 设为 `true` 时，转发调用方的 Authorization 头（鉴权委托给上游）         |
| `AGENT_ROUTE_OC_CHAT_URL` / `AGENT_ROUTE_OC_API_KEY` | 备用 OpenAI 兼容上游（也支持 `OC_CHAT_COMPLETIONS_URL` / `OC_API_KEY`） |

**方式二：在控制台 / provider 管理页添加启用状态的 provider 连接。** 这些连接持久化到本地数据库，由 router 在运行时读取并参与轮询和 failover。`src/core/router/runtime.js` 内置对 OpenRouter、OpenAI、Gemini、DeepSeek、Kimi/Moonshot、GLM/智谱等的路由，按模型前缀（`openrouter/`、`gemini/`、`gc/`、`deepseek/`、`kimi/`、`glm/` 等）匹配。

未配置任何上游时，内部模型调用会返回一条明确的错误，提示配置 `AGENT_ROUTE_UPSTREAM_CHAT_URL` 或添加 provider 连接。

## Commander 模型

| 变量                                                                                   | 说明                                          |
| -------------------------------------------------------------------------------------- | --------------------------------------------- |
| `AGENT_ROUTE_COMMANDER_MODELS` / `AGENT_ROUTE_COMMANDER_MODEL`                         | 覆盖 commander 模型列表（逗号分隔，前者优先） |
| `NEXT_PUBLIC_AGENT_ROUTE_COMMANDER_MODELS` / `NEXT_PUBLIC_AGENT_ROUTE_COMMANDER_MODEL` | 前端展示用的 commander 模型                   |

模型池默认值在 `src/config/models/default-model-pools.js`，分为 `commander` / `strong` / `coding` / `free` 等池；模型等级定义在 `model-tiers.js`（free=L0、coding=L1、strong=L2、commander=L3、codex-cli=local）。

## 网络、CORS 与开发

| 变量                                  | 默认                     | 说明                                                                            |
| ------------------------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| 端口                                  | `20128`                  | 由 `npm run dev` / `dev:lan` 脚本指定                                           |
| `AGENT_ROUTE_ALLOWED_ORIGINS`         | 空                       | 逗号分隔的允许 origin 白名单（用于 CORS）                                       |
| `AGENT_ROUTE_ALLOW_LAN_DEV`           | 关                       | 设为 `1` 时，开发环境允许局域网（192.168 / 10 / 172.16-31）origin；生产环境无效 |
| `AGENT_ROUTE_PUBLIC_URL`              | `http://localhost:20128` | OpenRouter `HTTP-Referer` 等外部标识                                            |
| `AGENT_ROUTE_SHOW_NEXT_DEV_INDICATOR` | 关                       | 设为 `1` 显示 Next.js 开发指示器                                                |
| `NODE_ENV`                            | ——                       | `production` 时关闭本地 dev origin 放行                                         |

开发环境中，`localhost` / `127.0.0.1` / `::1` 默认被视为允许 origin（生产环境不放行）。CORS 与 origin 判定细节见 [安全设计](security.md)。

出站代理相关：`AGENT_ROUTE_OUTBOUND_PROXY_URL`、`AGENT_ROUTE_HTTPS_PROXY`、`AGENT_ROUTE_NO_PROXY`、`AGENT_ROUTE_SYSTEM_PROXY`。

## 本地请求鉴权

| 变量                                          | 说明                                         |
| --------------------------------------------- | -------------------------------------------- |
| `AGENT_ROUTE_DISABLE_LOCAL_AUTH`              | 设为 `1` 时关闭本地 API key 校验（全部放行） |
| `AGENT_ROUTE_API_KEY_SALT` / `API_KEY_SECRET` | API key 派生 / 校验相关                      |

未配置任何启用的本地 API key 时，鉴权层依赖默认的 loopback 绑定而对本地请求放行；一旦存在启用的 key，跨域 / 非 UI 调用必须携带有效 key。生成 key 见 [开发与运维](development.md)。

## 工具相关

| 变量                                                                | 默认            | 说明                                               |
| ------------------------------------------------------------------- | --------------- | -------------------------------------------------- |
| `AGENT_ROUTE_BROWSER_CHANNEL`                                       | `chrome`        | Playwright 浏览器 channel                          |
| `AGENT_ROUTE_WEB_TRANSPORT`                                         | 自动            | `fetch` 或 `curl`，强制 web 工具的传输方式         |
| `AGENT_ROUTE_WEB_SEARCH_PROVIDER`                                   | ——              | web 搜索 provider 选择                             |
| `AGENT_ROUTE_TAVILY_API_KEY` / `TAVILY_API_KEY`                     | ——              | Tavily 搜索 key                                    |
| `AGENT_ROUTE_CODEX_CWD`                                             | `process.cwd()` | codex-cli 工作目录                                 |
| `AGENT_ROUTE_CODEX_SANDBOX`                                         | ——              | codex-cli sandbox 模式                             |
| `AGENT_ROUTE_CODEX_OAUTH_BASE_URL` / `_CHAT_URL` / `_RESPONSES_URL` | ——              | codex OAuth 上游                                   |
| `AGENT_ROUTE_PDF_TIMEOUT_MS`                                        | ——              | PDF 处理超时                                       |
| `AGENT_ROUTE_DISABLE_LOCAL_ENV`                                     | 关              | 设为 `1` 时不向 codex-cli 等子进程透传本地环境变量 |

## 默认运行与预算策略

运行策略（`src/config/policies/runtime-policy.js`）默认值：

```text
maxTasks: 3              maxGoalIterations: 4     callTimeoutMs: 120000
modelMaxAttempts: 3      toolMaxAttempts: 3       toolRetryDelayMs: 500
planMaxTokens: 1600      reviewMaxTokens: 2600    codexCliTimeoutMs: 180000
verifierModelEnabled: true   verifierTimeoutMs: 45000   dynamicFreeModels: true
```

预算策略（`src/config/policies/budget-policy.js`）默认值（`mode: "limited"`）：

```text
goal:  maxTokens 180000 · maxCostUsd 1.5 · maxRuntimeMs 30min · maxSteps 120
       · maxBrowserActions 80 · maxRetries 8 · maxConcurrentWorkers 1
task:  maxRetries 4 · maxRuntimeMs 3min · maxTokens 50000
       · maxBrowserActions 20 · maxShellActions 30 · maxVerificationRetries 1
worker: maxTokens 32000 · maxCostUsd 0.5 · maxPromptTokens 22000
thresholds: warning 0.7 · degraded 0.85 · emergency 0.97
```

预算可以通过用户配置文件或请求体覆盖；含负数的预算字段会被忽略并回退到默认值。

## 用户配置文件

在 home 目录放置 `agent-route.json`（或用 `AGENT_ROUTE_CONFIG` 指定路径），即可覆盖运行 / 预算 / 模型池 / prompt 等配置。该文件**不应**提交真实 API key 到版本库。

```bash
# 示例：临时改用自定义配置文件
AGENT_ROUTE_CONFIG=/path/to/agent-route.json npm run dev
```
