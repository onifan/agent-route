# AgentRoute Studio

**本地优先、目标驱动的自治 Agent 控制台，内置 Agent 专用的模型路由服务。**

AgentRoute Studio 把一句自然语言"目标"（goal）转化成一个可观测、可恢复、可审计的执行闭环：策略生成 → 任务分解 → 依赖图调度 → 工具执行 → 证据收集 → 验证与真实性检测 → 复盘迭代 → 最终合成。它不是聊天界面，也不是对外的模型代理产品——公开的 OpenAI 兼容入口（`/v1/*`）已被显式关闭，模型调用能力只服务于 Agent 内部的 commander / planner / worker / verifier / reviewer / finalizer 等角色。

整个目标执行过程受四道机制约束：确定性风险闸门、强制验证层、预算治理系统、以及对高风险动作的人工确认。

> **当前定位：** 适用于本地开发、研究、低风险自动化和 Agent 运行时实验。任何涉及真实账号、付款、表单提交、生产变更或敏感数据的动作都会被风险闸门拦截，必须经过人工确认。

---

## 核心能力

- **Agent 内部模型路由** —— 通过配置的 OpenAI 兼容上游、OAuth provider 或自定义 upstream 完成内部模型调用，支持连接轮询、failover 和响应格式兼容。
- **目标驱动 Agent** —— 从一个 goal 生成策略、任务图、worker 执行、证据、验证、复盘和最终答案。
- **任务状态机与执行图** —— 集中管理任务生命周期，基于依赖关系判断哪些任务 ready。
- **风险系统** —— 在 shell / file / browser / web / codex-cli 工具执行前进行确定性风险判定，high / critical 风险未批准不予执行。
- **验证与真实性检测** —— worker 成功不等于任务完成；系统校验证据，识别重复内容、空链接、占位符和伪造的成功。
- **预算与资源监控** —— 跟踪 token、成本、运行时长、重试、浏览器动作和降级状态，防止死循环。
- **记忆、纠正动作与学习** —— 记录失败原因、建议动作、历史成功率和用户覆盖，用于改进后续决策。
- **运行监控与恢复** —— 提供事件流、任务时间线，以及预算 / 风险 / 验证仪表盘和重启后的安全恢复。

---

## 技术栈

Next.js 16（App Router）· React 19 · Node.js ≥ 22 · LangGraph（编排）· Model Context Protocol SDK（工具协议）· Playwright（浏览器工具）· Zod · Zustand · 可选 better-sqlite3（本地持久化）

---

## 快速开始

**环境要求：** Node.js `>=22`，npm，macOS 或 Linux。

```bash
npm install
npm run dev
```

默认端口为 `20128`，构建输出目录为 `.next-cli-build`（非默认 `.next`）。

打开控制台：<http://localhost:20128/agent-route>

**最小内部模型配置**（让 commander / planner / worker / verifier / finalizer 能调用上游模型）：

```bash
export AGENT_ROUTE_UPSTREAM_CHAT_URL="https://your-openai-compatible-endpoint/v1/chat/completions"
export AGENT_ROUTE_UPSTREAM_API_KEY="<your-api-key>"
npm run dev
```

也可以不用环境变量，直接在 `/agent-route` 控制台或 provider 管理页里添加一个启用状态的 OpenAI 兼容 provider 连接。

**生产构建与启动：**

```bash
npm run build            # next build + scripts/build.js 结构校验
npm run start:production # 启动 .next-cli-build/standalone/server.js，默认绑定 127.0.0.1
```

---

## 运行一个目标

目标运行的入口是 **`POST /api/agent-route/ui-stream`**（Vercel AI SDK 的 UIMessage 流）。它会进入 LangGraph runner，按 `validate_request → prepare_run → execute_goal → complete_run` 四个节点执行，并通过事件流持续推送 strategy / plan / graph / budget / 任务状态 / verification / final 等事件。

```bash
curl -N -X POST http://localhost:20128/api/agent-route/ui-stream \
  -H "Content-Type: application/json" \
  -d '{ "messages": [{ "role": "user", "content": "分析这个仓库并说明当前的 agent 执行流程，不要修改任何文件。" }] }'
```

`/api/agent-route/run` 不再承载目标流——它的旧 SSE 目标流已被禁用（返回 410），现在仅用于 action 类调用（如 `config_status`、`recovery_status` 等）：

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{ "action": "config_status" }'
```

完整的 action 列表、端点和 MCP 接口见 [API 参考](docs/api.md)。

---

## 常用命令

```bash
npm run dev            # 开发模式（端口 20128）
npm run build          # 生产构建 + 结构校验
npm run start:production # 启动生产 standalone 服务
npm run format         # Prettier 格式化
npm run format:check   # 仅检查格式
npm run lint           # ESLint
npm test               # 运行全部测试（src 下 23 个 *.test.js）
```

---

## 页面

| 页面              | URL                    | 说明                                                             |
| ----------------- | ---------------------- | ---------------------------------------------------------------- |
| 控制台 / 运行监控 | `/agent-route`         | 创建并运行目标、查看事件流、任务图、预算 / 风险 / 验证、恢复摘要 |
| Provider 管理     | `/dashboard/providers` | 配置内部模型 provider 连接与节点                                 |
| OAuth 回调        | `/callback`            | provider OAuth 授权回调                                          |

---

## 安全边界

默认情况下系统不会自动登录真实账号、绕过验证码、提交表单 / 订单 / 付款、发送真实消息、上传本地数据、变更生产环境、删除数据库文件，或读取 `~/.ssh`、`~/.aws` 等敏感凭证目录。命中这些动作时，确定性风险闸门会返回结构化的 blocked 结果并要求人工确认。详见 [安全设计](docs/security.md)。

---

## 文档

- [架构说明](docs/architecture.md) —— 双系统边界、目录结构、LangGraph 执行流程、模块清单
- [配置指南](docs/configuration.md) —— 环境变量、数据目录、默认策略、模型池、端口
- [API 参考](docs/api.md) —— 运行入口、action API 全量清单、MCP 端点、REST 端点
- [安全设计](docs/security.md) —— 请求鉴权、CORS、风险闸门规则、安全边界
- [开发与运维](docs/development.md) —— 命令、测试、构建校验、生产启动、本地 API key、故障排查

---

## 提交前检查

```bash
npm run format:check
npm run lint
npm test
npm run build
```

另外确认：

- 没有提交 `.env` 或真实 API key
- 没有提交 `.next-cli-build` 构建产物或 standalone 输出
- 没有提交日志、数据库、缓存、临时目录或含私有路径的截图
- 没有高风险动作绕过风险闸门
- 没有把安全判断重新放到前端推导
