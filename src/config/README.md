# Config

集中管理 prompts、policies 和 models 配置。

业务代码不应散落硬编码 prompt、风险策略、预算策略、验证策略或模型成本信息。

- `prompts/`: 默认 prompt settings。
- `models/`: 默认模型池和模型等级。
- `policies/`: 默认预算、风险、验证、人工确认、无人值守策略。
- `loader/`: 统一加载默认配置、用户覆盖、校验、脱敏和运行时路径。

工具默认策略也放在 `policies/`，例如 browser 工具的 adapter、headless、截图目录和快照大小限制。
