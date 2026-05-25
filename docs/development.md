# 开发和运维

本文档记录 AgentRoute Studio 的本地开发、测试、运行恢复、场景测试和故障排查。

## 常用命令

```bash
npm run format
npm run format:check
npm run lint
npm test
npm run build
```

命令说明：

- `format`：用 Prettier 格式化 `src`、`app`、`scripts`、根目录配置、Markdown 和 docs。
- `format:check`：检查格式，不写入文件。
- `lint`：运行 ESLint。
- `test`：运行当前 Node 测试。
- `build`：运行 Next 构建并执行项目结构校验脚本。

## 测试范围

`npm test` 覆盖：

- 安全回归
- 配置加载器
- storage repositories
- tools runtime
- evidence normalizer
- verification file intent
- authenticity
- corrective actions
- action decision
- action learning
- decision attribution
- recovery
- dashboard
- task runtime
- memory runtime
- internal model service
- observability runtime

## 生产启动

```bash
npm run build
npm run start:production
```

如果 standalone 构建不存在，`scripts/start-production.js` 会提示先运行 `npm run build`。

## 主要页面

地址：

```text
/agent-route
```

页面包含：

- 控制中心
- 目标和任务列表
- 任务执行图
- 任务详情
- 风险和人工确认
- 验证和真实性判断
- 建议动作和排序
- 行为经验和决策归因
- 运行监控中心
- 恢复摘要
- 模型、prompt 和主题设置

## 运行恢复

服务重启、进程被杀、Mac 或服务器断电后，系统可以扫描 repository 里的持久化状态并做安全恢复。

恢复原则：

- `running` task 不会继续假装在执行，会被安全标记为 blocked 或可重试状态。
- `waiting_human` task 保持等待人工确认。
- `completed`、`failed`、`cancelled` task 不会被错误修改。
- 旧 browser session 默认 stale，不自动复用。
- 丢失的 Codex CLI 或 worker 进程不会被假设成功。
- 如果存在 evidence 或 artifact，也必须经过 verification 才能算完成。

查询恢复摘要：

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{
    "action": "recovery_status"
  }'
```

手动运行恢复扫描：

```bash
curl -X POST http://localhost:20128/api/agent-route/run \
  -H "Content-Type: application/json" \
  -d '{
    "action": "run_recovery"
  }'
```

恢复事件会进入事件流和运行监控中心。

## Evidence 和 Verification

所有 worker 都应该返回 evidence。系统会先标准化 evidence，再进入 verification。

browser evidence 会统一包含：

- `type`
- `evidenceSource`
- `action`
- `detectedActionType`
- `url`
- `previousUrl`
- `nextUrl`
- `urlChanged`
- `title`
- `textPreview`
- `screenshotPath`
- `snapshotPath`
- `durationMs`
- `ok`
- `confidence`
- `resourceUsage`

文件验证前会经过 file intent detector。`Node.js`、`React`、`Next.js`、`Python`、`Docker`、`AWS` 等技术词不会因为看起来像扩展名就被误判成文件路径。

## 真实性和建议决策

False Success Detection 会给结果打 `authenticityScore`：

- `0.85` 到 `1.0`：高度可信
- `0.7` 到 `0.85`：可信
- `0.55` 到 `0.7`：弱可信
- `0.35` 到 `0.55`：可疑
- `<0.35`：高度可疑

常见 warning：

- 重复项目
- 空标题
- 空链接
- 占位文本
- 字段完整率低
- 页面证据不足
- 结果像 hallucination

Corrective Action Engine 会生成建议动作，Action Decision Engine 会排序，但不会自动执行。最终是否重试、人工复核、取消或继续，仍由用户或上层流程决定。

## 开发约定

请保持这些模块边界：

- 普通模型路由不要依赖 agent 模块。
- 任务状态变化必须走任务模块或 repository 封装。
- worker result 必须包含 evidence，不能只返回“成功了”。
- task completed 必须经过 verification。
- high 或 critical risk 且未批准时，工具不能执行。
- budget 可以阻止 retry、降低模型等级或暂停流程。
- strategy 高于单个 task，planner 不能生成违反 strategy 的任务。
- dependency graph 决定哪些 task ready。
- tools 不写 memory、不改 task、不做业务判断。
- storage repository 不反向依赖 orchestrator。
- config loader 不依赖 agent/orchestrator，避免循环依赖。
- 不要记录或提交敏感信息。

## 故障排查

### 页面 404

请访问：

```text
http://localhost:20128/agent-route
```

如果你访问旧 dashboard 路径，它应该跳转到当前工作台。

### 局域网其他电脑打不开

开发环境默认只允许 localhost 和 127.0.0.1。需要局域网访问时：

```bash
AGENT_ROUTE_ALLOW_LAN_DEV=1 npm run dev -- --hostname 0.0.0.0
```

同时确认系统防火墙允许端口 `20128`。

### 生产启动提示 standalone build missing

先运行：

```bash
npm run build
```

再运行：

```bash
npm run start:production
```

### Playwright 不可用

browser 工具支持 mock adapter。真实 Playwright adapter 是可选能力。如果本地没有安装或配置 Playwright，测试仍应优先使用 mock adapter 或受控页面，不依赖外部真实网站。

### 任务显示 blocked

blocked 不一定代表系统坏了。常见原因：

- 风险过高，需要人工确认。
- 上游依赖失败或被阻塞。
- verification 没有通过。
- authenticity score 太低。
- 预算或 retry 超限。
- 重启后 worker 丢失，恢复机制安全阻塞。
- browser session 已失效。

请在任务详情中查看 blocked reason、verification reasons、authenticity warnings、risk history 和 event timeline。
