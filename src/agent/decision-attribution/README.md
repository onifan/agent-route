# Decision Attribution

Decision Attribution 记录“系统推荐动作”和“最终实际动作”之间的关系，用来区分成功来自系统建议、用户覆盖、人工复核和恢复流程。

本模块只做记录、归因和统计，不自动重试、不自动执行建议、不修改任务状态，也不替代 Action Decision 或 Action Learning。Action Learning 可以消费这里的 `decisionSource`、`wasOverridden` 和 `attributionScore`，避免把用户修正误算成系统建议成功。
