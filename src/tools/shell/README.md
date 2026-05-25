# Shell Tool

只负责命令执行、exit code、stdout、stderr 和基础超时结果。

危险命令识别、人工确认和预算限制不写在这里。

- `executor.js`: 执行命令并处理超时。
- `command-result.js`: 标准化命令结果。
