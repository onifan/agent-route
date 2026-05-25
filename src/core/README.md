# Core

Agent 内部模型调用核心。这里负责 provider 适配、模型池选择、连接轮询和 failover 策略。

不负责 goal、task、memory、risk、budget、verification 等目标驱动 agent 逻辑。公开 OpenAI-compatible `/v1/*` API 已关闭；这里仅为 agent 内部 commander、planner、worker、reviewer 和 finalizer 提供模型请求能力。
