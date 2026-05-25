# Models

集中存放模型等级、模型池、成本、能力标签和稳定性信息。

本模块只描述模型配置，不负责实际请求 provider。

- `default-model-pools.js`: commander/strong/coding/free 默认模型池和 commander 候选。
- `model-tiers.js`: 模型等级常量和等级顺序。
- `index.js`: 对外统一导出，core router 与 agent 编排层通过这里读取默认模型策略。
