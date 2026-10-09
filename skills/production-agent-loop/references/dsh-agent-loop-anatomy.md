# dsh Agent Loop 解剖

`SKILL.md` 里每条 runtime 原则背后的对照案例,按包边界进行概念解剖。第三方项目仅作为
公开设计参考;下方内容是本仓库的归纳说明,不是第三方源码或逐字摘录。

## 全局图景

dsh 把生产级 agent loop 拆成**两层**。唯一含 loop 逻辑的包是 `dsh-agent-loop`;其余
全是抽象服务或挂在扩展点上的插件。所有真相落在一个**事件溯源的 session log**,而 LLM
消息历史从它*派生*。

```text
                   dsh-agent (接口层, 零 loop 依赖)
                   ctx.agents / Agent 接口 / agent/* 事件词汇
                            ^ setFactory
                            | implements AgentFactory
   dsh-agent-loop (唯一具体 loop) --inject--> agents, sessions, llm, tools, systemPrompt
      ReactLoopAgent: turn -> step -> 模型调用 -> tool calls -> 重复
                            | 读写
                            v
   dsh-session (事件溯源 log + surface + deriveMessages)  <- 唯一持久权威
                            ^
        +-------------------+--------------------+-----------------+
   dsh-goal            dsh-tools            dsh-llm          dsh-compaction(-basic)
  (goal/change 事件)  (tools/* 流水线)   (provider 抽象)  (监听 pre-step / request-error)
        ^
   dsh-goal-round-driver (监听 agent/pre-step + idle;自动续跑)
```

解耦原文(`dsh-agent` README):*"Every plugin (UI, hooks, orchestrators) programs
against the `Agent` handle defined here — it has zero loop dependency, so the loop
is swappable."*(每个插件都面向此处定义的 `Agent` handle 编程——它零 loop 依赖,所以
loop 可替换。)loop 通过 `ctx.agents.setFactory(this)` 注册;消费方永远面向
`ctx.agents` 编程,从不 import `dsh-agent-loop`。

> 路径提示:每个包都在**双层嵌套**的
> `.../@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`
> 下(单层路径不存在)。

## 1. dsh-agent-loop —— 唯一的具体 loop 驱动器

**职责。** 具体 loop 驱动器负责 session/turn/step 生命周期,其余扩展行为通过插件接入,
以避免把所有策略堆进核心 loop。

**服务契约。** 注册 `ctx.agentLoop`,并把自己注册为 `ctx.agents` 的 `AgentFactory`。

```ts
export declare class AgentLoop extends Service implements AgentFactory {
    static inject: string[];   // agents, sessions, llm, tools, systemPrompt
    create(id: SessionId, options?: AgentOptions, meta?: Pick<SessionHeader,'cwd'>): Agent;
    createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>;
    resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>;
}
export interface Config {
    maxParallelToolCalls?: number;   // 默认 10;1 = 串行
    agents: (AgentOptions & { id: string; sessionId?; cwd?; resumeSessionId? })[];
}
```

内部驱动器是包私有的(exports map 无 `./src/*` 逃生口),所以它的方法名即 loop 结构,
但绝非公开 API:

```ts
// lib/types/agent.d.ts
export declare class ReactLoopAgent implements Agent {
    private kick; private preStep; private turn; private step; private buildRequest;
}
```

**注入的服务。** `agents`、`sessions`、`llm`、`tools`、`systemPrompt`(五个接口服务)。
对 `dsh-session-persistence` 是软 peer——`resume` 需要它,非持久化 demo 仍能跑。

**值得照搬的生产细节。**

- **turn / step 双层结构。** 驱动器拥有一个 agent 的整个生命期,跑在
  `ctx.agents.withInitiator(agent, ...)` 里。一个 turn 含一或多个 step;一个 step =
  一次模型调用 + 它请求的工具。
- **inbox 三个投递口。** 统一 `send(message, target, wakeup)` 原语;`followup`
  (next-turn FIFO + 唤醒)、`steer`(next-step + 唤醒)、`inject`(next-step,不唤醒)
  是固定预设别名。
- **每次调用一个完成锚点。** README:*"Every provider call that reaches a successful
  finish appends exactly one `assistant/message` completion anchor, including
  content-less calls and `max-tokens` finishes."*
- **并行调度。** `maxParallelToolCalls` 默认 **10**(`DEFAULT_MAX_PARALLEL_TOOL_CALLS`);
  `1` 为串行。独占调用形成屏障,安全调用走有界滚动池。
- **失败边界。** README:*"Plugin failure ends the current turn, not the loop."*
  终态模型请求失败到达 `agent/request-error`;middleware/工具/扩展抛出直接关 turn。
- **取消。** `turn/end` 对 `user`/`parent` 记 `aborted`,dispose 记 `disposed`;未
  分发的模型 tool call 收到合成 `tool/call` + `ABORTED_BEFORE_DISPATCH` 结果对。

## 2. dsh-goal —— 事件溯源的目标状态(CAS 栅栏 + 严格回放)

**职责。** 在一个 session 内维护一个当前完成目标,作为事件溯源的生命周期状态,带
compare-and-set 版本栅栏和进程本地的续跑启用位。它拥有*状态*,从不管调度。

**服务契约。** `ctx.goals`(`GoalService`)。动词:`get(agent)`、`create(agent, req)`、
`edit(agent, ref, req)`、`pause`/`resume`/`complete`/`block(agent, ref, reason)`、
`clear(agent, ref): GoalRef`,外加仅生命周期用的 `disarm(agent)`。每个变更方法接收一个
`GoalRef {id, revision}` 作为 CAS 栅栏,拒绝陈旧 ref。

```ts
export interface GoalRef { readonly id: GoalId; readonly revision: number; }  // CAS 栅栏
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';
export interface GoalSnapshot extends GoalRef {
    readonly objective: string; readonly phase: GoalPhase;
    readonly blockedReason?: GoalBlockReason; readonly maxGoalRounds: number;
}
export interface GoalSnapshotChangeMeta {   // durable 变更事件
    readonly kind: 'goal/change'; readonly version: 1;
    readonly operation: Exclude<GoalOperation,'clear'>;
    readonly goal: GoalSnapshot; readonly roundsStarted: number;
}
```

**注入的服务。** `dsh-agent`、`dsh-session`、`dsh-session-projection`、`dsh-scope`、
`dsh-llm`、`dsh-invariants`、`dsh-typert-protocol`。

**生产细节。**

- `defaultMaxGoalRounds` 默认 **256**。仅是一个 round *计数*预算——README:
  *"`maxGoalRounds` does not meter tokens, currency, wall time, or provider
  quotas."*
- README:*"Every mutation appends a durable `goal/change` event carrying the
  complete post-mutation snapshot ... The session log is the only durable
  authority."*
- **单一 `blocked` phase。** README:*"provider limits, configured budgets,
  execution errors, and requests for human input all use this one durable phase
  rather than multiplying lifecycle states."*
- **activation 从不持久化。** 每个 `agent/session-start` 边缘 disarm 它;resume/fork
  保留目标却不启动工作。

## 3. dsh-goal-round-driver —— 自动续跑

**职责。** 把一个"active + armed + 有剩余容量"的目标转成连续的 goal round,通过注入一个
`<goal_round>` 提示词。这是 dsh 里最接近"自主 loop"的东西——**而它是插件,不属于 loop。**

**服务契约。** 一个纯插件(`name`/`inject`/`apply(ctx)`),不注册服务。导出
`renderGoalRoundPrompt(goal, round): ContentBlock[]`。无配置:round 上限属于 goal 定义,
blocked 阈值属于 `dsh-tool-goal`——README 指出重复其中任一值"could produce divergent
policy"。

**注入的服务。** `dsh-agent`、`dsh-goal`、`dsh-session`、`dsh-llm`、`dsh-invariants`。
注意它**不** peer 依赖 `dsh-agent-loop`(仅在 devDeps)——这是"消费方用 `Agent` 接口
而非 loop"的物理证明。

**生产细节。**

- **idle-checkpoint 驱动。** agent 空闲且目标 active/armed/有容量时,它 checkpoint
  待处理的 goal 变更、预留 `roundsStarted + 1`、并排入一条 `<goal_round>` user 提示词
  (带 `GoalMessageSource`)。
- 只有真正进入一个 step 的 `user/message` 才 `roundsStarted++`;普通人类轮次从不消耗
  goal cap。
- **持久性义务。** `goal/changed` 后,它 `await ctx.sessions.flush()` 并在排队前复检
  revision。
- README:*"No abnormal auto-retry — transient provider and persistence failures
  require a later human-authorized resume."*

面向模型的完成/阻塞工具在 `dsh-tool-goal`:`update_goal(..., action, blocked_reason?)`。
README:*"An autonomous goal round that successfully reports `complete` or
`blocked` marks that tool execution with `concludeTurn()` so the physical turn
stops after the step."* 这正是把"任务完成"翻译成"loop 停止"的接缝。
`blockedAfterConsecutiveRounds` 默认 **3**。

## 4. dsh-tools —— 工具注册契约与执行流水线

**职责。** 工具注册表 + 五段式执行流水线 + 模型呈现模式(native / code / both)。

**服务契约。** `ctx.tools`(`ToolRuntime`)。核心方法:`register(def): () => void`
(scope 为调用上下文;在 `agent.ctx` 上注册会仅对该 agent shadow 同名全局)、
`execute(exec)`、`guard(guard): () => void`(pre-execute 后的单调同步守卫)、
`restrict` / `presentAs` / `get` / `schemas` / `executionMode`。

**五段式流水线**(README 顺序):
`tools/pre-execute`(可重排的 allow/deny/ask 门)-> 单调 `guard()` ->
`tools/execute`(around-dispatch 包裹:timeout/retry/metrics)->
`tools/post-execute`(检查/替换结果、附加 context)->
定义自有的 `finalizeContent` -> observe-only `tools/result`。

**注入的服务。** `dsh-agent`、`dsh-llm`、`dsh-session`、`dsh-system-prompt`、
`dsh-scope`、`dsh-code-runtime`、`dsh-user-approval`、`dsh-invariants`。只有
`SystemPrompt` 是硬注入(schema 自动喂入 prompt);approval 走机会式
`ctx.get('approval')`。

**生产细节。**

- **`defineTool` 完整形态**(`DefineToolOptions`):`name` / `description` /
  `parameters`(类型化 schema DSL,自动校验、自动推导 args 类型)/
  `output {schema, render, presentationMeta?}`(**强制**)/ `execute(args, exec)` /
  可选 `timeoutMs` / `isConcurrencySafe(args)` / `finalizeContent` / `presentCall` /
  `presentResult`。
- **无效参数走同一错误结果路径**:缺失必填 / 类型错误 / 枚举违规变成 `ToolArgsError`
  (code `INVALID_ARGS`)——不进 policy、不进 body。
- **`timeoutMs` 是声明式的。** README:*"the registry never enforces deadlines;
  enforcement requires `@deepseek-ai/dsh-tool-call-timeout-policy`"*——一个零配置的
  `tools/execute` 包裹,超时返回 `TOOL_TIMEOUT`,协作式,非硬杀。
- **并发。** `isConcurrencySafe(args)` 必须返回 exact `true` 才可并行;其余一律独占。
- **权限不是 `defineTool` 字段**——它是流水线事件(`tools/pre-execute` + `guard()`)。

```ts
export interface ToolExecutionSuccess {
    readonly isError: false;
    readonly value: JsonValue;          // 执行本地,不进 durable 事件
    readonly content: ContentBlock[];   // 模型看到的内容
    readonly meta?: JsonValue;
    readonly additionalContexts?: UserMessage[];
    readonly concludesTurn?: true;      // 工具可宣告 turn 结束 -> loop 退出
}
export interface ToolExecutionFailure {
    readonly isError: true;
    readonly error: ToolFailure;         // { message, info?: { name, code } }
    readonly content: ContentBlock[];    // 渲染后的错误文本(回喂模型)
    readonly value?: never;
    readonly additionalContexts?: UserMessage[];
}
export type PreToolDecision =
  | {kind:'allow'} | {kind:'deny', reason:string} | {kind:'ask', reason?};
export type PostToolDecision =
  | {kind:'accept'; content?; additionalContexts?}
  | {kind:'accept'; value; additionalContexts?}
  | {kind:'block'; feedback: ContentBlock[]};
```

## 5. dsh-agent —— Agent 接口(loop 与一切的接缝)

**职责。** 定义 `Agent` handle、注册表、进程本地 initiator scope、以及全套 `agent/*`
事件词汇——带**零 loop 依赖**,使 loop 可替换。

**服务契约。** `ctx.agents`(`AgentRegistry`):`register`/`enter`/`announce`/`get`/
`list`/`roots`/`isOwnedBy`、`create`/`resume`(委托给 factory)、`setFactory(factory)`、
以及四个 initiator-scope 方法(`currentInitiator` / `requireInitiator` /
`withInitiator` / `withoutInitiator`)。

```ts
export interface Agent {
  readonly id: SessionId; readonly session: Session; readonly inbox: Inbox;
  readonly status: AgentStatus;          // 'idle' | 'running'
  cancel(cause: AgentCancelCause, options?: CancelOptions): void;
  followup(message: UserMessage): void;  // next-turn + 唤醒
  steer(message: UserMessage): void;     // next-step + 唤醒
  inject(message: UserMessage): void;    // next-step, 不唤醒
}
```

**注入的服务。** `dsh-llm`、`dsh-session`、`dsh-system-prompt`、`dsh-scope`、
`dsh-typert-protocol`、`dsh-invariants`。**不** 含 `dsh-agent-loop`——可替换性的物理
保证。

**全套 loop 扩展事件都住在这里**(`runtime-types.d.ts`):

- `agent/pre-step`(waterfall)—— `PreStepDecision = {kind:'reject'} | {kind:'enter', messages}`;压缩/策略插件在此施压。
- `agent/request`(waterfall)—— 替换 frozen `LlmCallConfig`。
- `agent/request-error`(waterfall)—— 模型请求恢复接缝(见下)。
- `agent/turn-stopping`(serial)—— turn 关闭前;失控 turn 预算必须在此取消。
- `agent/status`(idle<->running)、`agent/error`、`agent/session-start`、`agent/created`/`disposed`、以及三个 inbox 事件。

```ts
'agent/request-error'(this: Scoped<Agent>, payload: {
    agent: Agent; turn: number; step: number; provider: string;
    failure: LlmFailure; retryPolicy: ResolvedRetryPolicy | undefined; signal: AbortSignal;
}, next: () => Promise<RequestErrorAction>): Promise<RequestErrorAction>;
```

## 6. dsh-llm —— 模型调用抽象(canonical 消息/内容/错误词汇)

**职责。** provider 中立的 LLM 词汇 + 抽象服务;loop、session log、所有插件共用的
canonical 语言。

**服务契约。** `ctx.llm`(`LlmRuntime`):`registerAdapter(providers, adapter)`、
`stream(options): AsyncIterable<StreamChunk>`(**唯一**的调用 API——原始 chunk 流)、
`prepareCall` / `resolveCallConfig`、`providerRetryPolicy(provider)`。唯一 waterfall
事件 `llm/stream` 包裹每次调用。

**生产细节。**

- **消息/内容模型:** `Message {id, role, content: ContentBlock[], source}`。内容块
  联合:`text` / `reasoning` / `image` / `tool-call` / `tool-result`。
- **流式协议:** 原始 chunk(`block-start` / `text-delta` / `reasoning-delta` /
  `tool-call-delta` / `block-end` / `usage` / `finish`);`BlockAssembler` 是唯一的
  装配算法。max-token 截断时丢弃无法安全执行的 tool call。
- **错误分类学(可恢复 vs 致命):** `LlmFailure {message, code, status?,
  providerRetryAfterMs?, requestId?}`——可序列化,**不携带 policy**。可重试:
  `EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`。不可:
  `QUOTA`、`INVALID_CREDENTIAL`、`CONTEXT_WINDOW_EXCEEDED`。`FinishReason`:
  `stop` / `tool-calls` / `max-tokens` / `aborted{failure}` / `error{failure}`。
- **重试是插件。** `dsh-llm-retry` 在 `agent/request-error` 上执行 provider-owned
  `retryPolicy`;默认 normal 模式重试 **2** 次,指数退避 500ms->10s + 10% jitter。
  README:*"every retry opens a fresh numbered turn"*——请求从 durable 历史重建。

```ts
export interface ToolResultMessage extends Message {
    readonly role: 'user';                 // 一个 tool result 就是一条 user 角色消息
    readonly content: [ToolResultBlock];
    readonly source: ToolMessageSource;    // { kind: 'tool', callId }
}
export interface ToolCallBlock   { type:'tool-call'; id: CallId; name: string; arguments: string; }
export interface ToolResultBlock { type:'tool-result'; toolCallId: CallId; content: ContentBlock[]; isError?: boolean; }
```

## 7. dsh-session —— 事件溯源 log(唯一持久权威)

**职责。** append-only 事件 log、它有序的消息 *surface*、以及 `deriveMessages()`。loop
不持有消息数组;它追加事件,历史从 log 折叠而来。

**surface vs log-only。** 只有三种事件类型进入喂给模型的 surface:`user/message`、
`assistant/message`、`tool/result`。一个 tool result 作为 `tool/result` 事件
`{turn, step, message: ToolResultMessage, error?, meta?}` 追加,带 `surfaceOp: 'append'`;
`deriveMessages()` 自动把它折进下一个请求。其余一切(chunk、usage、边界、
goal/compaction/retry 记录)都是 log-only。

完整的 durable 事件词汇(`known-event-types.js`)包括 `user/message`、
`assistant/message`、`assistant/chunk`、`tool/call`、`tool/result`、`turn/start|end`、
`step/start|end`、`goal/change`、`compaction/start|summary|end|prune`、
`llm/retry|retry-started`、`request/header|context`、`approval/*`、`todo/write` 等。
持久化读路径遇到本集合外的类型会拒绝重建,除非它被标记 `ignorable: true`。

## 8. dsh-compaction / dsh-compaction-basic —— 作为旁路的 context 管理

**职责。** `dsh-compaction` 定义契约(WHAT);`dsh-compaction-basic` 是具体后端
(HOW:token 压力 + 保留策略 + 一次性 `llm.stream()` 摘要)。

```ts
export declare abstract class CompactionEngine extends Service {
    abstract compactIfNeeded(agent, trigger: CompactionTrigger, signal): Promise<CompactionResult | null>;
    abstract compactNow(agent, signal, sourceCommandId?): Promise<CompactionResult | null>;
    abstract compactRegion(start: number, end: number, agent, signal?): Promise<CompactionResult>;
}
export type CompactionTrigger = 'pressure' | 'context-overflow';
```

**为什么这是 context 管理与 loop 解耦的铁证。**

1. `dsh-compaction` 是独立包,注册它自己的 `ctx.compaction` 服务;loop 的 peer 依赖里
   **不**包含它。
2. 它挂两个通用 loop 事件:`agent/pre-step`(压力)和 `agent/request-error`
   (canonical 溢出修复)。loop 对它毫无感知。
3. 它的摘要是一次**direct `ctx.llm.stream()` 调用,而非 loop step**
   (`GenerateOptions.purpose = 'compaction'`),所以逐调用拦截发生在 `llm/stream`。
4. 它从不删除 log 事件:一次成功压缩追加五个事件(`compaction/start` -> 摘要 ->
   `compaction/summary` -> 一条带 `surfaceOp: {op:'replace', start, end}` 的
   `user/message` -> `compaction/end`)。原始事件仍在;replay 保持确定性。
5. 连"多大算大"都住在别处(`ctx.tokenMeter`)。

默认值(`dsh-compaction-basic`):`thresholdRatio` **0.8**、`retainRatio` **0.16**、
`maxTokens` **8192**、`compactionRetries` 1、`auto` true。一个安全的压缩切点永不把
assistant tool call 和它的 result 拆开(`toolPairingBalancedBefore/After`)。可组合的
`dsh-compaction-tool-result-pruner` 把超预算的 `tool/result` 改写成 head + 省略 + tail
(`thresholdChars 8192` / `headChars 4096` / `tailChars 1024`),原事件保留。

## 文件路径速查

均在双层嵌套的 `@deepseek-ai/` 根下。

- Loop:`dsh-agent-loop/lib/types/{index,agent,tool-calls,constants}.d.ts` + `README.md`
- Goal:`dsh-goal/lib/types/{index,types,domain,fold}.d.ts`;驱动:`dsh-goal-round-driver/lib/types/{index,prompt}.d.ts`;模型工具:`dsh-tool-goal/README.md`
- Tools:`dsh-tools/lib/types/{index,schema}.d.ts` + `README.md`;超时:`dsh-tool-call-timeout-policy/README.md`
- Agent 接口:`dsh-agent/lib/types/{index,runtime-types,inbox}.d.ts`
- LLM:`dsh-llm/lib/types/{types,message,call-config,error,retry-policy,assembler}.d.ts`;重试:`dsh-llm-retry/README.md`
- Session:`dsh-session/lib/types/{index,types,surface,known-event-types}.d.ts`
- Compaction:`dsh-compaction/lib/types/index.d.ts`、`dsh-compaction-basic/lib/types/{config,summarizer}.d.ts`
