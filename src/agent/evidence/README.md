# Evidence

统一证据标准化层。

负责：

- 把 browser tool、Codex CLI 文本、普通 worker result、旧版 `evidence.browser` 转成统一 browser evidence。
- 对 URL query、token、cookie、password、secret、authorization 等敏感字段脱敏。
- 标注浏览器动作类型，例如 `read_page`、`submit_like_click`、`delete_like_click`、`payment_like_click`、`login_like_action`。

不负责：

- 风险等级判断。
- 任务状态更新。
- 产物登记。
- memory 写入。
- 自动登录、验证码处理、自动提交 proposal。

统一 browser evidence 会保留兼容字段，供 verification、risk、budget、artifact、observability 和 dashboard/API 稳定消费。
