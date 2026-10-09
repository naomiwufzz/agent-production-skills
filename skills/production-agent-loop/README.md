# production-agent-loop

一套可移植的生产级 **agent loop**（agent runtime）实现方法论,每条原则都用
**DeepSeek Harness（dsh）**——DeepSeek 官方基于 Cordis 插件系统构建的 agent
runtime——的真实做法来印证。

与从零开始的教程不同,这个 skill 把每条抽象原则都和一个真实、已发布的实现配对。dsh
是被用作样板的参考,不是必需的依赖:这些指导适用于任何语言或 SDK。

## 它做什么

- 定义三层边界:`ConversationManager` -> `QueryLoop` -> `ToolRuntime`
- 提供一个最小 loop 形状:模型调用、tool-call 检测、工具执行、`tool_result` 回喂、
  最终答案检测
- 论证 loop 的消息历史应当**从事件溯源的 log 派生**,而非持有一个可变数组——这样
  resume、fork、compaction 都白拿
- 规定**分层退出条件**,以及最重要的——*每个退出由哪一层拥有*(原生 loop 退出保持
  极简;预算/round 上限/目标达成都在上层)
- 给出 tool-runtime 契约:schema 校验、权限作为流水线关注点(而非工具字段)、声明式
  超时、并发安全
- 把错误分成可恢复(回喂模型)与致命(结束 turn)两类
- 论证 context 窗口管理属于一个响应 loop 事件的旁路插件,绝不内联在 loop 里

## 何时使用

当你想构建或审查一个 agent runtime、多轮 tool-calling loop、ReAct 式
reasoning-action-observation 循环、可替换的 loop 驱动器、事件溯源的对话状态、
turn/step 生命周期、`tool_result` 回喂、分层退出条件、可恢复-vs-致命错误处理、或一个
Claude Code / dsh 式的 agent loop 时,使用这个 skill。

触发词:"build an agent loop"、"agent runtime"、"tool-calling loop"、"ReAct
loop"、"swappable loop driver"、"event-sourced conversation"、"turn/step
lifecycle"、"tool_result feedback"、"max turns / round caps"、"dsh-like agent
loop"。

## 文件结构

```text
production-agent-loop/
├── SKILL.md                          # 主 skill:可移植原则 + 每节的 dsh 实证
├── README.md                         # 本文件
└── references/
    ├── production-loop-patterns.md   # 扩展的 provider 无关模式与故障模式
    └── dsh-agent-loop-anatomy.md     # dsh 逐包解剖,带真实类型签名
```

## 来源

本 skill 使用公开的 Agent runtime 设计作为对照案例,并将其中的事件溯源、分层退出和
工具运行时边界归纳为框架无关的工程原则。第三方项目名称仅用于说明参考背景,不表示
本仓库包含其源码或得到其背书。
