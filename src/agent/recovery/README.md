# Recovery

运行恢复模块负责在手动 API 调用时扫描持久化 goal/task 状态，把不可信的运行态安全收束。

负责：

- 从 repository/task runtime 读取持久化状态。
- 将重启后遗留的 `running` task 标记为安全停止状态。
- 保留 `waiting_human`、终态 task 和已暂停 goal。
- 处理 `retry_ready` task 的保守 requeue/block。
- 记录 task history、observability recovery events 和恢复摘要。
- 标记 browser session/worker process lost，不自动复用旧 session。

不负责：

- 后台调度、自动继续执行任务、自动登录、验证码处理、自动提交 proposal、自动付款。
- 直接相信中断前 worker 结果成功；产物和证据仍必须由 verification 判断。

入口：

- `runStartupRecovery()`: 可显式调用的保守恢复；默认不阻塞 Agent Route 新任务启动。
- `runRuntimeRecovery()`: 手动恢复扫描。
- `recoveryStatus()`: 查看最近恢复摘要。

API / 前端：

- `recovery_status`: 返回最近一次恢复摘要，包含扫描数量、恢复数量、worker 丢失、浏览器会话失效、warning/error 和建议操作。
- `run_recovery`: 手动触发一次保守恢复扫描。
- 前端“运行监控中心”会显示恢复状态卡片、恢复事件时间线，以及恢复后被阻塞任务的原因。
- 恢复后的高风险或状态不明任务只会提示人工处理，不会自动继续执行。
