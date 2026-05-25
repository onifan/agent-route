# Budget

负责 token、费用、运行时间、重试、浏览器动作、验证次数、模型降级和无限预算测试模式。

不执行模型调用。budget 可以影响 routing、暂停、阻塞或降级，但底层调用由 core/worker 完成。
