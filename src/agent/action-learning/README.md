# Action Learning

Action Learning 记录实际动作的真实运行结果，并聚合出 `actionStats`，供 Action Decision 在后续评分中参考。

本模块只做统计学习：记录动作类型、任务类型、目标类型、成功与否、成本、耗时、retry、风险、真实性分数、决策来源、是否覆盖系统建议和归因分数。来源字段来自 Decision Attribution，用于区分系统建议成功率、用户覆盖成功率和人工复核成功率。它不训练模型、不自动改 prompt、不自动重试、不操作浏览器，也不直接修改任务状态。
