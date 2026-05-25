# Action Decision

Action Decision 对 corrective engine 产生的 `recommendedActions` 做评分和排序，输出 `rankedActions` 与单个 `recommendedAction`。

本模块只做决策解释：综合真实性、风险、预算和历史信号估算成功率、成本、风险与是否需要人工。历史信号会优先参考系统建议成功率，避免把用户覆盖后的成功误算成系统建议本身有效。它不自动重试、不操作浏览器、不登录、不提交、不付款，也不直接修改任务状态。
