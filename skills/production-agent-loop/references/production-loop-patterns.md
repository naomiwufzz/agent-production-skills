# 生产级 Agent Loop 模式

生产级 agent loop 背后的、provider 无关的扩展模式。在设计一个新 loop、审查一个已有
loop、或向另一位工程师解释这套架构时读它。配套的
[`dsh-agent-loop-anatomy.md`](dsh-agent-loop-anatomy.md) 把这里的每条模式都落到 dsh
的具体实现上。

## ReAct 到 Agent Loop 的映射

| ReAct 概念 | 生产级 agent loop |
|---|---|
| Thought | 模型 reasoning / 隐藏的 thinking 块 |
| Action | 结构化的 tool/function call |
| Observation | 结构化的 tool-result 消息 |
| Answer | 没有 tool call 的 assistant 响应 |

生产 loop 不解析 "Thought" 文本。API 响应已经告诉 runtime 模型是否想调工具。最终答案
的检测是"没有 tool call",绝非文本启发式。

## 模块边界

```text
ConversationManager
  - 持久消息 / 事件 log
  - session 持久化
  - 用户设置和鉴权
  - 总用量和预算

QueryLoop
  - 每 turn 和每 step 的状态
  - 模型调用
  - tool-call 检测
  - 续跑决策
  - 终止原因

ToolRuntime
  - 工具注册表
  - schema 校验
  - 权限检查(作为流水线,而非工具字段)
  - 工具执行
  - tool_result 格式化
```

每个单元都应能被独立理解和测试:你能说清它做什么、怎么用、依赖什么,而无需读其他单元
的内部。

## 可替换的 Loop

把 loop 藏在一个接口后面,让系统的其余部分面向它编程——一个带 `send` / `cancel` /
`status` / 事件流的 `Agent` handle——这样没有任何插件、UI 或编排器会 import loop 内部。
回报是:你可以替换 loop 驱动器(比如换一套调度策略)而不触碰消费方,也可以用一个假
handle 对消费方做单测。

## 续跑决策

只有当模型产出了至少一个 tool call 时才续跑:

```text
if tool_calls.length === 0:
  return completed
else:
  execute tools
  append tool_results
  call model again
```

这是"模型看到观察结果、再思考一次"的工程等价物。

## 从 Log 派生历史

最健壮的 loop 不把 `messages` 当作真相之源。它们持有一个**append-only 事件 log**,并
*派生*出发给模型的消息列表:

```text
append 事件: user/message, assistant/message, tool_call, tool_result, ...
derive(messages) = fold(过滤到 "surface" 事件类型的 log)
```

为什么这很重要:

- **Resume / fork** 变得平凡——replay log 即可重建状态。
- **Compaction** 是一次遮蔽旧节点的 log append,而非一次改动。
- **取消** 可以确定性地合成缺失的 tool result。
- **审计** 是精确的——每个 step 都可重建。

区分 *surface* 事件(喂给模型的:user、assistant、tool result)和 *log-only* 事件
(原始流 chunk、usage、生命周期边界、retry/compaction 记录)。只有 surface 参与
`deriveMessages()`。

## 分层退出条件

最常见的 loop bug 是退出缺失或放错层。按"哪一层拥有它"来拆分:

| 退出 | 层 | 由什么发信号 |
|---|---|---|
| 模型没有更多 tool call | loop | provider `stop` finish |
| 不可恢复的错误 | loop | 抛出的异常结束 turn |
| 单次调用 max tokens | loop | provider finish reason |
| 取消 / 超时 / deadline | 调用方 | `abort` 信号传入模型和工具 |
| 目标达成 | 工具 | 一个 tool result 标志位(如 `concludesTurn`) |
| round / turn 上限 | policy 层 | turn 之间检查计数器 |
| token / 成本 / 墙钟预算 | policy 层 | step 之间检查预算 |
| 权限拒绝 | tool runtime | 变成 tool 错误,通常不是 loop 退出 |

保持 loop 原生退出极简("没有 tool call"、"出错了"、"被取消")。把策略性退出推到
loop 之上,用 tool-result 标志位或外部 cancel 发信号。一次权限拒绝通常**不**是 loop
退出——把它作为 tool 错误返回,让模型选择另一个动作。

## Tool Result 形态

用 provider 原生形态。概念上它必须携带:

```ts
{ role: "tool", tool_call_id: call.id, content: serializedResult, is_error?: boolean }
```

如果 provider 期望 tool result 作为 user 角色的内容块,就保留它精确的配对规则。追加前
永远先做大小限制。

## 可恢复 vs 致命错误

两类,两个去处:

- **可恢复 -> 交给模型。** 无效参数、未找到、搜索为空、瞬时上游错误。格式化成一条
  标记 `is_error` 的 tool result,追加它,让模型自我纠正。loop 继续运行。
- **致命 -> 结束 turn。** 你自己 middleware 抛出、缺凭证、不可重试的 provider 失败。
  以明确的终止原因停止;别把它作为可纠正的观察结果交给模型。

用一个稳定的 code 给模型请求失败分类,并让 *policy* 决定可重试性——错误对象本身不应
携带 policy:

- 可重试:空响应、限流、服务器错误、超时、传输错误。
- 不可重试:配额耗尽、无效凭证、上下文窗口超限。

一次重试应当从 durable 历史*重建*请求(开一个新编号的 turn),而不是重发一个陈旧的
内存 payload。

## 并行 Tool Call

当模型在一个 step 里发出多个 tool call 时,并发运行更快——但只有部分工具可以安全并行。
把并发做成一个 per-tool、per-arguments 的决策:

- 工具声明 `isConcurrencySafe(args)`;只有明确的 `true` 才允许并行执行。任何未知、
  抛出、或非 true 的一律独占。
- 独占调用形成屏障;安全调用在一个有界的滚动池里运行。
- 保持 call/result 的 id 配对精确——id 错配是经典的并行 bug。
- 取消时:停止新的分发、drain 已开始的、并为从未运行的调用合成
  `aborted-before-dispatch` 结果,让历史保持一致。

## 保 KV-Cache 的历史

provider 只在某前缀的 token 在相同模型路由下保持逐字节相同时才复用它的 KV cache。把
历史增长设计成 **append-only**:

- 追加 user/assistant/tool-result 消息保留可复用的前缀。
- 一次历史中段的改写(编辑、重排、或 compaction 替换)从第一个改动的 token 起使复用
  失效——所以批量做这类改写,并预期这个代价。
- 系统 prompt 和工具 schema 每 step 都会重发;保持它们稳定以留住 cache。重排工具或
  重新生成 schema 会悄悄破坏复用。

## 安全清单

- 每个模型产出的 tool 输入都经过 schema 校验。
- 高风险工具需要显式权限或策略批准,且在副作用**之前**检查。
- 权限是流水线关注点,不是工具定义上的字段。
- tool result 在追加进历史前做大小限制。
- 安全时把 tool 错误格式化以供模型恢复。
- 致命错误以明确的终止原因结束 turn。
- `maxTurns`(或 policy 层里等价的 round 上限)是必备的。
- abort 信号传播进模型调用和工具。
- 长时工具发出进度,或移到后台任务。
- 当宿主产品拥有持久化时,消息持久化发生在昂贵/长时调用之前。

## 常见故障模式

- 因为任何一层都没有 turn/round 上限而死循环。
- tool 错误被抛出而非返回,导致模型无法自我纠正。
- tool 输出过大,撑爆下一个 prompt(没有大小限制)。
- tool result 以错误的 provider 角色/形态追加。
- 并行 tool call 产生错配的 call/result id。
- 权限检查在副作用之后才跑。
- 最终答案检测依赖文本启发式,而非"没有 tool call"。
- context 管理分支被内联进 loop,而非响应 loop 事件——使 loop 不可测、compaction
  无法推理。
- 历史被当作可变数组持有,导致 resume/fork/compaction 各需要一套定制代码。
- 重试重发一个陈旧的内存请求,而非从 log 重建。

