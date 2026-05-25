# Agent

目标驱动 agent 系统。这里承载 goal、strategy、task graph、risk、verification、corrective actions、action decision、decision attribution、action learning、budget、memory、artifact、observability 和 worker 编排。

不负责普通 chat/completions 的 provider 转发。跨模块变化优先通过事件和模块入口组合，避免直接写深层内部文件。
