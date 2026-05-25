# Browser Tool

真实浏览器工具层，只负责执行浏览器动作并返回结构化证据。

负责：

- 创建、复用、关闭浏览器会话。
- 打开页面、读取 URL/标题/页面文本。
- 点击、填写、滚动、等待 selector。
- 生成截图和轻量页面快照。
- 返回 `ok/action/sessionId/url/title/textPreview/screenshotPath/snapshotPath/durationMs/metadata/evidence/resourceUsage`。

不负责：

- 风险判断、人工确认、任务状态更新、业务产物登记、memory 写入、自动登录、验证码绕过、自动提交 proposal。

模块：

- `runtime.js`: 对外浏览器工具 API。
- `session-manager.js`: 会话创建、状态、复用、关闭、超时清理。
- `adapter-playwright.js`: 可选 Playwright 适配器。项目当前未强制依赖 Playwright，配置 `tools.browser.adapter=playwright` 且安装依赖后可启用。
- `adapter-mock.js`: 测试和无真实浏览器环境使用的 mock adapter，支持 data URL / file URL。
- `actions.js`: 兼容旧的 page 对象动作函数，并导出 runtime 动作别名。
- `snapshots.js`: 页面快照兼容入口。
- `screenshots.js`: 截图兼容入口。
- `result-normalizer.js`: 结构化结果、脱敏和 action 类型提示。

截图默认保存到 `AGENT_ROUTE_HOME/browser/screenshots`，快照默认保存到 `AGENT_ROUTE_HOME/browser/snapshots`。工具只返回路径和元数据，artifact 系统负责业务登记。

浏览器工具返回的 `evidence.browser`、`evidence.browserEvidence` 会被 `src/agent/evidence` 统一标准化。上层 verification/risk/budget/observability 应消费统一后的 evidence；browser 工具本身只负责收集 URL、标题、文本摘要、截图/快照路径和资源使用信息。
