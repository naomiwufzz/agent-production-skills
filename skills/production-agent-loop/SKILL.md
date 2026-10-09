---
name: production-agent-loop
description: Implement a production-grade agent loop (agent runtime) for AI applications, using DeepSeek Harness (dsh) as the worked reference implementation. Use this skill whenever the user wants to build an agent runtime, a multi-turn tool-calling loop, ReAct-style reasoning-action-observation cycles, a swappable loop driver, event-sourced conversation state, turn/step lifecycle, tool_result feedback, layered exit conditions (max turns, goal round caps, budgets, cancellation), recoverable-vs-fatal tool error handling, or a Claude Code / dsh-like agent loop in their own product or codebase.
---

# 生产级 Agent Loop

一套可移植的生产级 agent loop（agent runtime）实现方法论,每条原则都用
**DeepSeek Harness（dsh）**——DeepSeek 官方基于 Cordis 插件系统构建的 agent
runtime——的真实做法来印证。dsh 在这里是成熟的样板,不是必需的依赖:这些原则在
任何语言或 SDK 下都独立成立。

## 核心思想

把 loop 当作产品基础设施来建,分三层,而不是拿 prompt 硬拼:

```text
ConversationManager -> QueryLoop -> ToolRuntime
```

- `ConversationManager` 拥有持久状态:session id、消息历史、预算、持久化。
- `QueryLoop` 拥有单个任务轮次:调模型、检测 tool call、执行工具、追加结果、重复。
- `ToolRuntime` 拥有已注册的工具:schema、校验、权限检查、执行、错误格式化。

用 ReAct 作心智模型,但把它实现成结构化的 API 流量——provider 的响应已经告诉你
模型是否想调工具,所以你永远不必解析自由文本的 `Thought:`/`Action:`:

```text
Thought -> Action -> Observation -> Answer
模型 text/reasoning -> tool_call -> tool_result -> 下一次模型调用 -> 最终文本
```

> **对照案例。** 一个成熟的 Agent runtime 通常会把事件溯源 session、具体 loop 驱动器
> 和工具运行时拆开；loop 保持窄小,新行为通过插件或扩展点接入。
## 实现流程

1. **勘察当前的 LLM 调用点。** 找到消息在哪里组装、模型在哪里被调用、是否已配置
   结构化的 tool/function calling。
2. **引入一个最小 loop。** 第一版保持窄:一个模型调用函数、一个工具注册表、明确
   的退出条件。
3. **归一化消息形态。** 用 provider 原生的 tool-call 格式。除非 provider 没有
   tool-calling API,否则不要解析自由文本。
4. **加工具执行安全。** 用 schema 校验输入、对高风险工具做权限检查、把失败包装成
   tool result、记录每次调用。
5. **在扩展功能之前先加退出与预算护栏。** `maxTurns`、cancel/timeout、预算检查、
   致命错误路径,都要先于任何花哨行为。
6. **把 context 窗口策略放在 loop 之外。** loop 接收 messages、返回更新后的
   messages;裁剪、检索、摘要、压缩都在独立的一层(见下方"产品设计指南")。

## 最小 Loop

按你的语言和 SDK 调整这个形状:

```ts
async function runAgentLoop({
  initialMessages,
  model,
  tools,
  maxTurns = 10,
  signal,
}: {
  initialMessages: Message[]
  model: ModelClient
  tools: ToolRegistry
  maxTurns?: number
  signal?: AbortSignal
}) {
  let messages = [...initialMessages]

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) return { status: "aborted", messages }

    const response = await model.generate({
      messages,
      tools: tools.definitions(),
      signal,
    })
    messages.push(response.message)

    const toolCalls = extractToolCalls(response.message)
    if (toolCalls.length === 0) {
      return { status: "completed", finalMessage: response.message, messages }
    }

    for (const call of toolCalls) {
      const result = await tools.execute(call, { signal, messages })
      messages.push(makeToolResultMessage(call.id, result))
    }
  }

  return { status: "max_turns", messages }
}
```

"模型继续判断"这一步不是单独的函数——它发生在 loop 追加 `tool_result` 消息之后
再次调用模型的时候。

> **dsh 实证。** dsh 里的具体驱动器(`ReactLoopAgent`)是包私有的;消费方只碰
> `send` / `followup` / `steer` / `inject` 加上 `agent/*` 事件分类学。更锋利的
> 一课是:**loop 不持有可变消息数组**。每条消息都是 session log 里的 append-only
> 事件,请求历史在每个 step 从 log `deriveMessages()` *派生*出来。只有三种事件类型
> 能进入喂给模型的"surface"——`user/message`、`assistant/message`、`tool/result`
> ——其余(原始 chunk、usage、边界)都是 log-only。这正是 resume、fork、compaction
> 无需对 loop 特殊处理就能成立的原因。

## 必备退出条件

一个只会在"模型停了"时退出的 loop 会卡死、死循环、或烧光预算。把每条终止路径都
实现出来,并优先返回结构化的原因:

```ts
type TerminalReason =
  | "completed"          // 模型响应里没有 tool call
  | "max_turns"          // 模型-工具循环的固定上限
  | "aborted"            // 用户取消或超过 deadline
  | "permission_denied"  // 策略阻止了一个必需的动作
  | "budget_exceeded"    // token、成本或墙钟预算耗尽
  | "goal_reached"       // 某个工具/目标宣告任务完成
  | "fatal_tool_error"   // 不可恢复的失败
```

**关键的设计决策是:每个退出由哪一层拥有。** 原生 loop 退出应该极简——"没有更多
tool call"、"出错了"、"被取消"。所有*策略性*的退出(预算、round 上限、目标达成、
权限)都属于 loop 之上的层,由 tool result 的标志位或外部 `cancel()` 来发信号。

> **dsh 实证——这是最突出的一课。** dsh 的 loop 原生只认三种退出:无 tool call
> 的 `stop` finish、抛出的错误(结束当前 *turn* 而非 loop)、`cancel(cause)`。它的
> README 说得很直接:**"No built-in turn budget — a policy that bounds runaway
> turns must cancel from an existing lifecycle extension point such as
> `agent/turn-stopping`."**(不内置 turn 预算——想约束失控 turn 的策略必须从
> `agent/turn-stopping` 这样的生命周期扩展点去取消。)其余全部叠加在上层:
>
> | 退出 | 机制 | 归属 |
> |---|---|---|
> | 正常完成 | `stop` finish,无 tool call | loop(内建) |
> | 工具宣告完成 | tool result `concludesTurn: true` | 工具,如 `update_goal` 的 complete/blocked |
> | abort / 取消 | `agent.cancel(cause)` | 调用方 |
> | 致命错误 | middleware/工具抛出 -> 关 turn | loop |
> | max-tokens | provider finish reason | loop |
> | goal round 上限 | `defaultMaxGoalRounds`(默认 **256**) | `dsh-goal` 插件 |
> | goal blocked | 单一 durable `blocked` phase;`blockedAfterConsecutiveRounds` 默认 **3** | `dsh-goal` + `dsh-tool-goal` |
> | 权限拒绝 | `PreToolDecision {kind:'deny'}` -> 变成 tool 错误(不退出 loop) | `dsh-tools` 流水线 |
> | 预算 / 失控 | 监听器在 `agent/turn-stopping` 取消 | 你自己的 policy 插件 |
>
> 注意 `concludesTurn`:这是把"任务完成"翻译成"loop 该停了"的精确机制——是一个
> tool result 携带信号,而非 loop 逻辑。

## Tool Runtime 契约

每个工具应定义:

```ts
type Tool = {
  name: string
  description: string
  inputSchema: unknown
  risk: "read" | "write" | "execute" | "external"
  validate(input: unknown): ValidatedInput
  canUse(input: ValidatedInput, ctx: ToolContext): Promise<PermissionDecision>
  call(input: ValidatedInput, ctx: ToolContext): Promise<ToolResult>
}
```

执行顺序:

```text
按名字找工具
-> 用 schema 校验模型的输入
-> 跑工具专属校验
-> 检查权限
-> 调用工具
-> 把成功或错误格式化成 tool_result
```

当模型有合理机会自我纠正时,把工具错误*回喂给模型*——无效参数、文件未找到、搜索
为空、瞬时 API 错误。只有在安全违规、反复失败、缺凭证、预算耗尽时才停止 loop。

> **dsh 实证。** dsh 的五段流水线是
> `tools/pre-execute -> guard() -> tools/execute -> tools/post-execute ->
> finalizeContent -> tools/result`。它的 `defineTool` 带 `parameters`(类型化
> schema,自动校验)、一个**强制的** `output` 声明、`execute(args, ctx)`、一个
> **声明式的** `timeoutMs`(注册表从不执行 deadline——由独立的
> `tool-call-timeout-policy` 插件执行,且是协作式,绝非硬杀)、以及
> `isConcurrencySafe(args)`。注意什么**不是** `defineTool` 字段:**权限**。
> deny/ask 决策是流水线事件(`tools/pre-execute` + 单调的 `guard()`),把"工具是
> 什么"和"此刻谁可以运行它"分开。

## 错误处理:可恢复 vs 致命

把失败分成两类,去往两个不同的去处:

- **可恢复 -> 回喂给模型。** 参数错误、未找到、结果为空、瞬时上游错误。格式化成
  一条标记 `is_error` 的普通 tool result,追加它,让模型在下一 step 自我纠正。
  loop 继续运行。
- **致命 -> 结束 turn。** 你自己 middleware 里未捕获的异常、缺凭证、不可重试的
  provider 失败。这些以明确的终止原因停止当前 turn;它们不作为可纠正的观察结果交
  给模型。

> **dsh 实证。** 工具失败变成 `ToolExecutionFailure { isError: true, error:
> { message, info: { name, code } }, content }`——`content` 就是模型看到并据以
> 自我纠正的内容;loop 不退出。模型请求失败由 `LlmFailure.code` 分类:
> `EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT` 可重试
> (`dsh-llm-retry` 插件在 `agent/request-error` 上重试,**每次重试开一个新 turn**),
> 而 `QUOTA`、`INVALID_CREDENTIAL`、`CONTEXT_WINDOW_EXCEEDED` 不可重试。错误对象
> 可序列化且**不携带 policy**——由 policy 插件决定可重试性,而非错误本身。
> middleware/扩展抛出的异常绕过 tool 错误路径,直接关 turn。

## tool_result 如何重新加入对话

一次 tool call 的结果必须在下一次模型调用前,以 provider 原生形态回到历史里。概念上
它携带:

```ts
{ role: "tool", tool_call_id: call.id, content: serializedResult, is_error?: boolean }
```

如果 provider 期望 tool result 作为 user 角色的内容块,就保留它精确的配对规则。追加
前先对结果做大小限制——一个巨大的结果会撑爆下一个 prompt。

> **dsh 实证。** 一个 tool result 是 `ToolResultMessage`,**`role: 'user'`**,
> `content: [ToolResultBlock]`,`source: { kind: 'tool', callId }`。loop 追加一个
> durable 的 `tool/result` 事件;下一 step `deriveMessages()` 自动把它折回去。因为
> loop 从 log 派生而非改数组,call/result 的 id 配对在 resume 和 replay 中都能存活。

## 产品设计指南

把"智能"留在模型里,把"可靠性"留在代码里:

- 让模型决定它是否需要再调一次工具。
- 让代码强制 schema、权限、预算和 loop 退出。
- 让 prompt 聚焦于工具语义和任务策略。
- 让实现聚焦于确定性的控制流。

**把 context 窗口管理放在 loop 之外。** 裁剪、检索、摘要、压缩是一个响应 loop 事件
的旁路关注点——绝不是 loop 内部的内联分支。

> **dsh 实证——context 管理是旁路插件的铁证。** dsh 的 `dsh-compaction` 是一个独立
> 包,注册它自己的 `ctx.compaction` 服务;loop 的依赖里**不**包含它。压缩挂在两个
> 通用 loop 事件上——`agent/pre-step`(token 压力)和 `agent/request-error`
> (canonical 溢出修复)。它的摘要是一次**direct `ctx.llm.stream()` 调用,而非
> loop step**。它从不删除 log 事件;它追加一条带 `surfaceOp: { op: 'replace' }`
> 的 `user/message` 来*遮蔽*旧节点,`deriveMessages()` 反映这个替换。连"多大算大"
> 都住在别处(`ctx.tokenMeter`)。loop 永远只往 log 追加;关于历史大小的一切都在它
> 之外决定。

对于简单的 AI 应用,一开始别上 subagent、worktree、流式工具执行。只有当产品真的需要
并行工作、隔离、或长时任务时才加。

## 需要更多细节时

- 读 [`references/production-loop-patterns.md`](references/production-loop-patterns.md)
  获取扩展的、provider 无关的模式:退出条件分层表、可恢复/致命二分、从 log 派生历史、
  并行工具的并发安全、保 KV-cache 的 append-only 历史、以及常见故障模式。
- 读 [`references/dsh-agent-loop-anatomy.md`](references/dsh-agent-loop-anatomy.md)
  当你想要 dsh 具体实现的逐包解剖(`dsh-agent-loop`、`dsh-agent`、`dsh-session`、
  `dsh-goal`、`dsh-goal-round-driver`、`dsh-tools`、`dsh-llm`、`dsh-compaction`)
  加真实类型签名时——它既是设计模板,也是你需要读懂或扩展 dsh 本身时的参考。
