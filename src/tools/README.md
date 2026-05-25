# Tools

底层工具能力集合。工具只负责执行 web、浏览器、shell、文件、codex-cli 等动作，并返回标准化结果。

风险、预算、验证和状态流转不写在工具里，由 agent 模块统一处理。

- `codex-cli/`: 调用本地 Codex CLI、处理临时输出文件、过滤日志、标准化执行结果。
- `web/`: 只读公开网页搜索和 URL/API fetch，返回 URL、HTTP status、title/text 和 API evidence。
- `shell/`: 执行命令并返回 `stdout`、`stderr`、`exitCode`、`durationMs` 等结构化结果。
- `files/`: 文件存在性、大小、读取、写入、哈希、临时文件/目录。
- `browser/`: 浏览器会话、可选 Playwright 适配器、mock adapter、页面动作、页面快照、截图结果收集。

边界：

- tools 不负责风险决策；危险动作是否允许由 `agent/risk` 判断。
- tools 不负责结果是否达标；成功判定由 `agent/verification` 完成。
- tools 不登记业务产物；artifact 生命周期由 orchestrator 和 `storage/repositories/artifact-repository.js` 处理。
- tools 不修改 task/goal 状态，也不反向依赖 `agent/orchestrator`。
- browser 工具遇到登录页、验证码、支付、删除、提交等情况只返回证据；是否继续由 risk/verification/human approval 决定。
- browser evidence 统一由 `src/agent/evidence` 处理；tools 层不判断风险、不验证是否成功，也不登记产物。
