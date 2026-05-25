# Verification

负责确认 worker 结果是否真实存在，包括 evidence、文件、shell、browser、API 和语义质量检查。

不相信 worker 自称成功。只有验证通过或被明确接受的结果，才应推动 task completed。

`file-intent/` 负责在文件存在检查前判断候选文本是否真的像文件路径。它会把 `Node.js`、`React`、`Next.js`、`Python`、`Docker`、`AWS` 等技术词排除，避免普通成功标准被误当成本地文件检查。

`authenticity/` 负责 False Success Detection。它会对空输出、列表、浏览器读取和 proposal 草稿做规则型真实性评分，输出 `authenticityScore`、`authenticityWarnings`、`authenticityReasons`、`authenticitySignals` 和 `decisionSource`。真实性太低时，verification 不会直接让任务 completed，并由 dashboard 展示原因和建议动作。
