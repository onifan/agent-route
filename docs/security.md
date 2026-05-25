# 安全设计

AgentRoute Studio 的原则是：完成目标不高于安全。系统可以长期运行和调用工具，但所有可能产生外部副作用或破坏性后果的动作都必须经过确定性风险门禁和必要的人工确认。

## 明确不做的事情

默认不会自动执行：

- 自动登录真实账号
- 自动绕过验证码或平台风控
- 自动提交 proposal、表单、订单或付款
- 自动发送真实消息
- 自动上传敏感文件
- 自动执行生产环境变更
- 自动删除重要数据
- 自动读取密钥目录或凭证文件

如果任务涉及上述行为，系统应返回 blocked result 或进入 waiting human，而不是继续执行。

## 工具风险闸门

web、shell、files、browser、codex-cli 等工具入口前都有确定性 risk gate。不能只依赖 prompt 文本提醒模型。

未批准时，high 或 critical 风险动作必须返回结构化 blocked result：

```json
{
  "blocked": true,
  "riskLevel": "critical",
  "reasons": ["dangerous shell command"],
  "requiredApproval": true,
  "actionSummary": "rm -rf ..."
}
```

至少拦截：

- `rm -rf`
- `sudo`
- `curl | sh` 或 `wget | sh`
- `npm publish`
- `git push`
- `docker compose down`
- `kubectl delete`
- `kubectl apply`
- 数据库写入类操作
- 生产环境变更
- 登录、付款、提交表单、上传、发送真实消息
- 读取 `.ssh`、`.aws`、`.config` 等敏感目录

## 风险等级

风险等级和 complexity 是两套独立系统。

- `low`：只读、低副作用，例如读取页面、`ls`、`cat`。
- `medium`：普通文件修改、普通导航、低风险自动化。
- `high`：提交表单、登录、发送真实消息、删除文件、停止服务、敏感上下文操作。
- `critical`：`rm -rf`、生产部署、发布包、数据库删除、付款、危险系统命令。

风险系统可以根据 retry 次数、异常行为、重复 submit、长时间无人值守、免费模型异常等情况升级风险。

## Browser 安全边界

browser 工具只负责执行底层动作和收集证据，例如 URL、标题、文本摘要、截图路径和页面快照。它不负责判断是否应该提交、付款、登录或绕过风控。

遇到以下情况时，只返回 evidence：

- 登录页
- 验证码
- 支付页
- 删除按钮
- submit 按钮
- 上传控件
- 真实消息发送界面

是否继续由 risk engine 和人工确认决定。

## Verification 安全边界

worker 自称成功不等于任务完成。verification 会检查：

- 文件是否真的存在或变化
- shell exit code、stderr、输出目录和目标文件
- browser URL、标题、页面文本、截图和 success/error message
- API response status、body 和数据写入结果
- semantic result 是否满足 success criteria
- authenticity score 是否可信

如果 verification 或 authenticity 发现不可信结果，任务不能直接 completed。

## 敏感信息脱敏

任何暴露给 dashboard、API、日志或 README 的内容都不能包含：

- API key
- token
- cookie
- password
- secret
- authorization header
- OAuth credential
- URL query 中明显敏感参数
- 本机隐私路径

证据层和配置加载器都应做脱敏。截图文件本身可能包含隐私信息，因此不要把截图或浏览器快照默认提交到 git。

## CORS

CORS 由 `src/security/cors.js` 集中处理。

生产环境不要默认：

```text
Access-Control-Allow-Origin: *
```

应通过 `AGENT_ROUTE_ALLOWED_ORIGINS` 明确配置允许的 origin。本地开发默认允许 localhost 和 127.0.0.1。

局域网开发需要显式打开：

```bash
AGENT_ROUTE_ALLOW_LAN_DEV=1 npm run dev -- --hostname 0.0.0.0
```

## Git 安全清单

提交前检查：

- 没有提交 `.env` 或任何真实 key。
- 没有提交 `.next`、`.next-cli-build`、standalone 构建产物或根目录生成的 `server.js`。
- 没有提交日志、数据库、缓存、临时目录、截图或包含隐私路径的文件。
- 没有把高风险动作绕过 risk gate。
- 没有在前端重新推导后端安全决策。
- 没有在测试数据或场景配置中放入真实凭证。

建议运行：

```bash
npm run format:check
npm run lint
npm test
npm run build
```

## 高风险任务处理建议

对于真实账号、真实交易、真实提交、生产变更或敏感数据：

1. 让系统生成草稿、计划或证据。
2. 通过 verification 和 authenticity 检查结果质量。
3. 在 dashboard 中查看 risk history、task event 和 evidence。
4. 人工确认后再执行下一步。
5. 保留事件和恢复摘要，方便审计。
