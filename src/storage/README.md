# Storage

负责数据库连接、迁移和 repository 数据访问封装。

业务模块不应到处直接写 SQL 或直接操作持久化细节。

当前底层没有更换数据库，repository 层仍兼容现有 JSON runtime store。新代码应优先通过 `src/storage/repositories` 访问 goal、task、memory、event、artifact、budget、risk、verification 和 model stats，未来可在不改业务模块的前提下替换为 SQLite/Postgres。
