# Files Tool

只负责文件存在、读取、目录枚举、文件发现、写入、哈希、大小等基础能力。

不负责产物生命周期、敏感信息策略或任务状态变化。

- `file-store.js`: 文件存在、大小、读取、目录枚举、文件发现、写入、路径信息。
- `hashing.js`: 文件 hash。
- `temp-files.js`: 使用 `AGENT_ROUTE_HOME/tmp` 或 `AGENT_ROUTE_TMP` 管理临时路径。
