# Corrective

根据 verification、authenticity、risk 和 task 状态生成纠正建议。

本模块只输出 `recommendedActions`，不自动重试、不操作浏览器、不登录、不提交、不修改任务状态。执行建议仍由 orchestrator、人工确认或后续任务流程决定。

当前动作类型包括：`retry_task`、`retry_with_different_model`、`rerun_browser`、`request_human_review`、`request_more_data`、`mark_as_blocked` 和 `continue`。
