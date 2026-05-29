# 开发与运维

本文档记录本地开发、测试、构建、生产启动、本地 API key 与故障排查。

## 环境要求

- Node.js `>=22`、npm。
- macOS 或 Linux。
- 浏览器工具需要 Playwright 可用的 Chrome（channel 默认 `chrome`，见 [配置指南](configuration.md)）。
- 本地持久化需要可选依赖 `better-sqlite3`；它放在 `optionalDependencies`，缺少构建工具时安装不会失败，相关功能会返回明确错误。

## 常用命令

```bash
npm run dev              # 开发模式，端口 20128（next dev --webpack）
npm run dev:lan          # 同上，但开放局域网（AGENT_ROUTE_ALLOW_LAN_DEV=1 + 0.0.0.0）
npm run build            # next build（输出到 .next-cli-build）+ scripts/build.js 结构校验
npm run build:next       # 仅 next build
npm run start:production  # 启动 .next-cli-build/standalone/server.js（默认绑定 127.0.0.1）
npm run format           # Prettier 写入
npm run format:check     # Prettier 仅检查
npm run lint             # ESLint
npm test                 # 运行 src 下全部 *.test.js
```

也提供 bun 变体：`dev:bun`、`build:bun`、`start:bun`。

> 构建输出目录是 `.next-cli-build`（在 `next.config.mjs` 用 `distDir` 指定），不是默认的 `.next`。`output: "standalone"`，并把 `/v1/:path*` rewrite 到 `/api/v1/:path*`。

## 测试

`npm test` 串行运行 `src/` 下的测试文件（Node 原生 `assert`，无测试框架），覆盖：

```text
security-regression · config-loader · storage-repositories · tools-runtime
agent-evidence · agent-verification-file-intent
agent-authenticity · agent-corrective · agent-action-decision · agent-action-learning
agent-decision-attribution · agent-recovery · agent-document-generation
agent-route-dashboard · agent-orchestration · agent-route-task-runtime
agent-route-memory-runtime · agent-route-model-proxy · agent-route-observability-runtime
agent-mcp-server · agent-mcp-worker-client · agent-langgraph-runner
```

单独运行某个测试：

```bash
node src/agent-langgraph-runner.test.js
```

## 构建校验（`scripts/build.js`）

`npm run build` 在 `next build` 之后运行该脚本，做结构与语法校验：检查关键页面 / API 路由 / runtime 入口文件是否存在、agent 各模块目录是否齐全、并对若干源文件做内容断言（如 studio 页面包含任务生命周期视图、Memory 视图等）。任一检查失败会抛错中断构建，全部通过时打印 `Build validation passed.`。

## 生产启动

```bash
npm run build
npm run start:production
```

`start-production.js` 会检查 `.next-cli-build/standalone/server.js` 是否存在，默认设置 `HOSTNAME=127.0.0.1`。要对外暴露需显式设置 `HOSTNAME=0.0.0.0`（脚本会警告），并务必配置本地 API key。

## 本地 API key

当存在启用的本地 API key 时，跨域 / 非 UI 调用必须携带它（见 [安全设计](security.md)）。用脚本生成 / 查看：

```bash
node scripts/create-api-key.js                 # 创建名为 "default" 的 key
node scripts/create-api-key.js --name "my-ide"  # 指定名称
node scripts/create-api-key.js --list           # 列出现有 active key
AGENT_ROUTE_DB=/path/to/data.sqlite node scripts/create-api-key.js  # 指定数据库
```

数据库位置解析顺序：`AGENT_ROUTE_DB` → `$AGENT_ROUTE_HOME|$DATA_DIR/db/data.sqlite` → `~/.agent-route-studio/db/data.sqlite`。

调用时携带：

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{ "action": "config_status" }'
```

## 运行恢复

重启后可用 action 查询和触发恢复（处理残留 running task、worker lost、stale browser session 等）：

```bash
curl -X POST http://localhost:20128/api/agent-route/run -d '{ "action": "recovery_status" }'
curl -X POST http://localhost:20128/api/agent-route/run -d '{ "action": "run_recovery" }'
```

恢复策略在 `src/config/policies/recovery-policy.js`，逻辑在 `src/agent/recovery`。

## 故障排查

- **内部模型调用报错 "Configure an active model API entry …"**：没有匹配的模型 API。打开 `/agent-route#model-apis`，启用对应 provider 并填写 API Key、Base URL、默认模型和模型列表。
- **`/api/agent-route/run` 跑目标返回 410**：旧 SSE 目标流已禁用，改用 `/api/agent-route/ui-stream`（见 [API 参考](api.md)）。
- **`/v1/*` 返回 404**：公开兼容入口被显式关闭，符合预期。
- **跨域请求 401**：已配置本地 API key，但请求未携带或无效；带上 `Authorization: Bearer <key>`，或确认为同源请求。
- **预检 403**：origin 不在白名单。配置 `AGENT_ROUTE_ALLOWED_ORIGINS`，或在开发环境用 loopback origin。
- **持久化相关报错**：可能是 `better-sqlite3` 不可用。安装构建工具后重装，或接受退化为内存 / JSON 行为。
- **任务一直 blocked / waiting_human**：命中风险闸门或预算 / 策略停止条件；查看 `risk_monitor`、`budget_monitor` 和 task 详情，必要时用 `approve_task` 批准。

## 提交前检查

```bash
npm run format:check
npm run lint
npm test
npm run build
```
