# Tasks

负责单个任务生命周期和任务状态机。状态变化应集中经过本模块。

不负责 worker 自证成功。任务完成必须经过 verification，并且可能被 risk、budget、graph 约束拦截。
