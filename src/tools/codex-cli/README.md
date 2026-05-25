# Codex CLI Tool

负责调用本地 codex-cli、收集执行结果并标准化 worker 输出。

不绕过风险、预算和验证系统；执行结果必须带 evidence。

- `runtime.js`: 底层 `codex exec` 调用、超时处理、stdout/stderr 收集。
- `result-parser.js`: 标准化 Codex CLI 结果。
- `log-filter.js`: 判断哪些日志可转发给前端。
- `temp-workspace.js`: 通过 tools/files 管理临时输出路径。
