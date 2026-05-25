# Prompts

集中存放 commander、planner、review、worker、codex-cli 等提示词配置。

本模块负责默认 prompt settings，不负责调用模型或解释任务结果。

- `default-prompt-settings.js`: AgentRoute 默认 commander/planner/review/final/worker/codex-cli prompt。
- `index.js`: 对外统一导出，业务模块只从这里读取默认配置。
