# Core Router

负责 Agent 内部模型请求、OpenAI-compatible provider 选择、请求/响应透传和本地 API key 注入。

不直接依赖 agent 任务状态、记忆、风险、预算或验证系统。公开 `/v1/chat/completions` 和 `/v1/responses` 入口不再提供模型代理服务；agent 运行时通过 `handleInternalModelRequest` 使用这里的 provider 能力。
