# 安全设计

核心原则：完成目标不高于安全。系统可以长期运行并调用工具，但所有可能产生外部副作用或破坏性后果的动作都必须经过确定性风险闸门和必要的人工确认。安全判断全部在后端完成，前端不重新推导。

## 网络暴露：默认 loopback 绑定

生产启动脚本 `scripts/start-production.js` 默认把服务绑定到 `127.0.0.1`（除非显式设置 `HOSTNAME` / `HOST`）。这是第一道、也是最硬的边界：默认情况下控制面和内部模型服务不会暴露到局域网。

如果设置了非 loopback 的 `HOSTNAME`，脚本会打印警告，提醒必须配置本地 API key，否则外部调用方将无需认证即可访问。开发模式可用 `npm run dev:lan`（`AGENT_ROUTE_ALLOW_LAN_DEV=1` + `--hostname 0.0.0.0`）显式开放局域网。

## CORS（`src/security/cors.js`）

- 允许的 origin 来源：`AGENT_ROUTE_ALLOWED_ORIGINS` 白名单（逗号分隔）。
- 非生产环境下，`localhost` / `127.0.0.1` / `::1` 自动放行。
- 开发环境 + `AGENT_ROUTE_ALLOW_LAN_DEV=1` 时，私网地址（`192.168.*`、`10.*`、`172.16-31.*`）放行；生产环境一律不放行私网。
- 预检（OPTIONS）：允许的 origin 返回 `204`，否则 `403`。允许的方法为 `GET, POST, OPTIONS`，允许的头为 `Content-Type, Authorization, X-API-Key`。

## 请求鉴权（`src/security/request-auth.js`）

在 loopback 绑定之上的第二层。`checkRequestAuth` 的判定顺序：

1. 若 `AGENT_ROUTE_DISABLE_LOCAL_AUTH=1` → 放行。
2. 若 `AGENT_ROUTE_UPSTREAM_FORWARD_AUTH=true`（鉴权委托上游）→ 放行。
3. 若没有任何启用的本地 API key → 放行（依赖 loopback 绑定，避免把新装用户锁在门外）。
4. 否则：仅放行同源请求（本地 Web 控制台），或携带有效 active key 的请求（`Authorization: Bearer <key>` 或 `X-API-Key`）。
5. 其余返回 `401 missing_or_invalid_api_key`。

active key 从本地数据库 `apiKeys` 表（`isActive = 1`）读取，带 30 秒缓存。若 `better-sqlite3` 不可用导致无法读取 key，会"fail open"——退回到仅依赖 loopback 绑定，而不是把用户锁死。生成 key 见 [开发与运维](development.md)。

## 确定性风险闸门（`src/security/tool-risk-gate.js`）

这是工具执行前的硬闸门，按工具类型对动作打风险等级（low / medium / high / critical），`gateToolAction` 在等级 ≥ high 且未获批准时返回 `blocked` 结构化结果（`ok:false`、`blocked:true`、`requiredApproval:true`、`riskLevel`、`reasons`、`riskFindings`）。判定纯规则、不依赖模型。

闸门会先剥离"否定 / 条件"语句（如"不要提交"、"如需付款则人工确认"），再对剩余的可执行意图判风险，避免被提示语里的免责声明绕过。敏感信息（token / cookie / password / key 等）在 finding details 中被脱敏。

各工具的判定要点：

- **shell**：`rm -rf` / 管道下载执行（`curl … | sh`）/ 包发布（npm publish 等）/ 数据库写删（drop / truncate / delete / update …）/ 操作生产资源 / `kubectl delete|apply` 判为 critical；`rm` 删除、`sudo`、`git push`、`docker compose down` 判为 high；触碰 `~/.ssh`、`~/.aws`、`~/.config`、`~/.gnupg`、`~/.kube` 等凭证目录判为 high。
- **file**：写 / 删 `.sqlite` / `.db` 等数据库文件判为 critical；操作敏感凭证目录判为 high。
- **browser / web**：付款 / 购买、删除真实数据判为 critical；登录 / 认证、提交 / 发送 / 发布、上传判为 high；web 工具的私网 / loopback / link-local 目标、非 HTTP(S) 协议、非法 URL 判为 high。
- **codex-cli**：复用 shell 与 browser 的规则评估指令内容；试图绕过安全 / 审批规则的指令判为 high。

风险策略数据（只读 / 文件变更命令清单、高危 / 关键模式、浏览器动作分级、升级阈值）定义在 `src/config/policies/risk-policy.js`。Agent 侧的风险升级、人工确认状态机在 `src/agent/risk`。

## 安全边界

默认情况下系统不会自动执行以下动作；命中时风险闸门返回 blocked 并要求人工确认：

- 登录真实账号
- 绕过验证码 / 平台反爬机制
- 提交提案、表单、订单或付款
- 发送真实消息
- 上传敏感 / 本地文件
- 执行生产环境变更
- 删除重要数据或数据库文件
- 读取凭证文件或敏感目录（`~/.ssh`、`~/.aws` 等）

## 验证与真实性

worker 报告成功不等于任务完成。`src/agent/verification` 在任务标记完成前校验证据；`verification/authenticity` 进一步识别重复内容、空链接、占位符和伪造的成功。未通过验证的任务不会进入完成态，复盘阶段也会阻止在计划内任务未解决时给出最终答案。

## 提交前安全检查

- 不提交 `.env` 或真实 API key。
- 不提交 `.next-cli-build` 构建产物 / standalone 输出 / 根目录生成的 `server.js`。
- 不提交日志、数据库、缓存、临时目录或含私有路径的截图。
- 不让高风险动作绕过风险闸门。
- 不把安全判断重新放到前端推导。
