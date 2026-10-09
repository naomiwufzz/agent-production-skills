---
name: production-agent-intent
description: '为生产级 AI Agent 设计并实现意图识别(意图分类 + 槽位补全 + 拒识/澄清出口)。当 agent 需要把用户自由输入映射到有界意图集、按需激活领域分类、补全必填参数、或对超范围/元问题诚实兜底时使用本技能——尤其是需要闭集分类、离线可评估、fail-open 安全的场景。触发词: "意图识别", "意图分类", "intent recognition", "intent classification", "slot filling", "槽位补全", "拒识", "澄清", "closed-set classification", "NLU", "对话理解".'
---

# 生产级意图识别

一套可移植的生产级意图识别实现方法论,每条原则都用
**@webb/dsh-intent**——基于 Cordis 插件体系、为 DeepSeek Harness 造的意图识别插件——
的真实做法来印证。dsh-intent 在这里是成熟的样板,不是必需的依赖:这些原则在任何
语言、任何 agent 框架下都独立成立。

## 核心思路

把意图识别当作 agent 的输入理解层来建:用户的自由文本先经过规范化增益,再经闭集
分类落到已知意图,最终通过明确的出口把「不知道」诚实地分流出去——而不是硬猜一个
结果。

```text
用户自由输入
  ↓
[规范化] 词汇表注入 + 模糊澄清 (脏输入喂分类器 = 垃圾进垃圾出)
  ↓
[闭集分类] 宿主模型调 report_intent → { intent, slots, missing_slots, confidence }
           意图只能从 intents.yml 枚举里选,绝不即兴发明
  ↓
[判定优先级]
  意图级出口 (先判,meta 短路):
    meta        → 元问题/闲聊 → 正常作答,不进入意图流程
    unsupported → 超范围任务  → 礼貌拒识
    unclear     → 信息不足   → 澄清追问
  ↓ (若为合法意图)
  槽位级出口:
    low_confidence → 信心低  → 澄清确认
    missing_slots  → 缺必填  → ask_user / auto_fetch 补全
    ok             → 全齐   → 执行意图
```

意图识别质量必须可量化:Top-1 准确率、拒识准确率、槽位完整率。没有评估集就是在
瞎调。

## 五条核心准则

这五条准则是本方法论的脊椎。后续工作流的每个步骤都服务于其中一条或多条。

**1. 闭集有界（Bounded closed set）**
意图只能从枚举清单里选,绝不即兴发明。开放生成 = 幻觉。清单外的输入必须落到保留
意图,而非硬编一个不存在的意图名。违反后果:模型自创 `debug_performance` 之类的意图
名,下游代码无处路由,静默失效或报错。

**2. 诚实出口（Honest exits）**
不确定时绝不硬分类。信息不足 → 澄清（unclear）；确实是任务但超范围 → 拒识
（unsupported）；根本不是任务（问能力/闲聊）→ 正常作答（meta）。三个出口都是一等
公民,不是异常兜底。违反后果:把「你能做什么」误判成 unsupported,用户体验断崖下跌。

**3. 先规范化输入（Normalize first）**
分类前先消解黑话/别名/歧义(词汇表注入 + 模糊澄清)。脏输入喂给分类器 = 垃圾进垃圾
出。规范化是分类的前置增益,不是可选项。违反后果:同义词「查询」「搜一下」「找找看」
命中率参差不齐,靠 prompt 调整不稳定,词汇表一次性解决。

**4. 确定性内核（Deterministic core）**
LLM 只负责「读输入、提候选读法」,最终判定、缺槽重算、优先级裁决全在纯函数里。不
信模型自报的 missing_slots(以 spec 必填集为准重算),不拿 confidence 做硬路由(自评
分不可靠,只驱动澄清)。违反后果:依赖模型自报缺槽,补全逻辑随模型表现漂移,无法
稳定测试。

**5. 可评估（Evaluable）**
意图识别质量必须可量化——Top-1/Top-K 准确率、拒识准确率、槽位完整率,由离线评估集
驱动,而非凭感觉。没有评估集就是在瞎调。违反后果:无度量基线,每次调参靠主观感觉,
无法量化回归,无法防止退化。

## 设计边界:刻意不做的取舍

这套方法论落地时按 YAGNI 收窄。以下几条是 dsh-intent 代码里真实存在的设计决策——不是没时间做,是**判断不该做**:

- **分类不额外调 LLM**:不搭独立的规则层/检索层,借宿主推理里的一次 `report_intent` 工具调用回收分类结果,零额外模型开销。宿主本身已是高推理水位,再叠一层性价比低。
- **confidence 不做硬路由**:自评分不可靠,只用来驱动 `low_confidence` 澄清出口(亮出候选请用户确认),绝不拿它自动切换模型或分支。
- **槽位不建模硬/软约束**:槽位统一 key-value,约束语义交给模型自己推断,spec 层不显式区分,也不做跨轮槽位状态追踪(每次 `report_intent` 独立评估)。
- **按需激活,向下兼容**:探到 `intents.yml` 才进领域模式;没有 spec 的项目零负担,行为退化为纯词汇表 + 模糊澄清。

这些边界的代码印证见 [`references/real-world-case.md`](references/real-world-case.md)。

## 工作流

### 0. 架构:纯函数内核 + 薄接线

动手前先定分层。意图识别代码天然分成两类:**判定逻辑**(给定分类结果和 spec,算出
Outcome)和**宿主接合**(注入工具、挂 pre-step hook、触发补全流程)。把它们严格分层,
内核零 I/O:

```typescript
// 内核:纯函数,零宿主依赖,可独立单测
function evaluateClassification(
  result: ClassificationResult,
  spec: IntentSpec
): EvalDecision { /* 纯逻辑,无 I/O */ }

// 接线壳:唯一碰 host API 的入口
function inject(ctx: AgentContext): void {
  ctx.tools.register(makeReportIntentTool(ctx))
  ctx.hooks.on('agent/pre-step', makeClassificationGuide(ctx))
}
```

fail-open 铁律在此建立:分类失败(report_intent 未调用、解析出错)一律降级到通用
流程,绝不抛出错误阻断 agent 执行。pre-step hook 只追加提示,从不返回 reject。

(回扣准则 4)

### 1. 外化意图集 `intents.yml`

把意图定义外化到 `intents.yml`,而非硬编码在 prompt 或代码里。每次 session 启动时
读取并注入为工具描述和分类约束:

```yaml
version: 1                      # 整数,字符串会硬校验失败
slots: []                       # 顶层数组,放共享槽位;每项用 globalRequired: true 标记全局必填
intents:
  - name: explain_code
    desc: 解释一段代码的结构或逻辑
    boundary: 只解释不改写       # boundary 在意图上,非顶层
    slots:
      - name: file_path
        desc: 要解释的文件路径
        required: true
        source: ask_user         # source 是槽位补全策略字段,值为 ask_user|auto_fetch
    fewshot:                     # fewshot 单数,嵌在意图下,非顶层
      - input: 帮我看看 src/index.ts 怎么写的
        intent: explain_code
        slots: { file_path: src/index.ts }
  - name: run_tests
    desc: 运行项目测试套件
    slots: []
```

三个保留意图 `unclear` / `unsupported` / `meta` 不可被用户重定义,始终存在于闭集的
保留区,不得出现在 `intents` 列表里。schema 完整定义见 [`references/intent-spec-schema.md`](references/intent-spec-schema.md)。

(回扣准则 1)

### 2. 闭集分类回收

宿主模型在推理时调 `report_intent` 工具提交分类结果。这次 tool call 是零额外 LLM
调用的:它借宿主推理里已经发生的一次完整推理来顺带提交意图:

```typescript
// report_intent 工具参数结构(真实导出类型名: ClassificationResult)
interface ClassificationResult {
  intent: string            // 必须是 intents.yml 中的枚举值(含三个保留意图)
  slots: Record<string, unknown>
  missing_slots: string[]   // 模型自报,仅参考,内核按 spec 重算
  confidence: number        // 0-1 自评分,不做硬路由,只驱动澄清
}
```

内核拿到 `ClassificationResult` 后,不信任 `missing_slots`(模型自报可能不准),改由
`evaluateClassification` 按 spec 必填集重算真正缺少的槽位。类型定义见
[`references/classification-contract.ts`](references/classification-contract.ts)。

(回扣准则 1+4)

### 3. 判定优先级

判定分两层,意图级先于槽位级。意图级三个出口互斥,`intent` 只取其一;meta 先判并
短路,避免元问题被误读为超范围任务。**正确的优先级顺序是意图级整体先于槽位级**,
而非 unsupported > unclear > meta:

```typescript
function evaluateClassification(
  spec: IntentSpec,
  result: ClassificationResult,
  confidenceFloor: number
): EvalDecision {
  // 未知意图名先规范化:不在枚举里的 → 'unclear'(防准则1被绕过)
  const intent = normalizeIntent(spec, result.intent) // unknown → 'unclear'

  // 意图级 (先判,meta 短路)
  if (intent === 'meta') return { outcome: 'meta' }
  if (intent === 'unsupported') return { outcome: 'unsupported' }
  if (intent === 'unclear') return { outcome: 'unclear' }

  // 槽位级 (仅合法业务意图才到这里)
  const intentDef = spec.intents.find(i => i.name === intent)
  const globalRequired = spec.slots
    .filter(s => s.globalRequired)
    .map(s => s.name)
  const intentRequired = intentDef?.slots.filter(s => s.required).map(s => s.name) ?? []
  const actualMissing = [...globalRequired, ...intentRequired].filter(s => !result.slots[s])

  if (result.confidence < confidenceFloor)
    return { outcome: 'low_confidence' }
  if (actualMissing.length > 0)
    return { outcome: 'missing_slots', missing: actualMissing }
  return { outcome: 'ok', intent, slots: result.slots }
}
```

(回扣准则 2)

### 4. 槽位补全

判定为 `missing_slots` 时,按每个槽位声明的 `source` 决定补全方式:

```typescript
async function fillMissingSlots(
  intentDef: IntentDef,
  missing: string[],
  ctx: AgentContext
): Promise<Record<string, unknown>> {
  const filled: Record<string, unknown> = {}
  for (const slotName of missing) {
    const slotDef = intentDef.slots.find(s => s.name === slotName)!
    if (slotDef.source === 'auto_fetch') {
      // 调内部工具自动获取(如查当前工作目录、读上下文日志)
      filled[slotName] = await ctx.tools.call(slotDef.fetchTool!, {})
    } else {
      // source: 'ask_user': 向用户发出澄清追问,等下一 turn 补全
      ctx.messages.push({
        role: 'assistant',
        content: `为了继续,请提供:${slotDef.desc}`
      })
    }
  }
  return filled
}
```

`source` 字段在 `intents.yml` 中声明,不靠模型自报的 `missing_slots` 列表——后者
仅作参考,真正缺少哪些槽位由步骤 3 的纯函数重算决定。

(回扣准则 3+4)

### 5. 软强制引导

用 pre-step hook 在每轮至多注入一次「先分类」提示,引导宿主模型主动调 `report_intent`。
关键约束:pre-step **绝不返回 reject**,不拦截任何已有 user 消息:

```typescript
ctx.hooks.on('agent/pre-step', ({ messages }) => {
  // 本轮已有 report_intent 调用,跳过
  if (hasReportIntentThisTurn(messages)) return

  // 没有分类请求时,轻柔注入一次提示(至多一次,不重复)
  if (!hasGuideInjectedThisTurn(messages)) {
    return {
      injection: '请先用 report_intent 工具标明本次请求的意图和必要参数,再执行具体操作。'
    }
  }
  // 注意:永远不返回 reject 或 error —— fail-open 铁律
})
```

这是软强制:模型不遵守时 agent 仍继续执行,不中断会话。强制拒绝是反模式(见「反
模式」节)。

(回扣准则 2)

### 6. 离线评估

意图识别必须有量化基线,否则每次调参都是瞎调。评估集由真实或构造的测试用例组成,
三个核心指标由纯函数 scorer 计算:

```typescript
// eval-cases.json 示例
const cases: EvalCase[] = [
  {
    input: '帮我解释一下 src/index.ts',
    expectedIntent: 'explain_code',
    expectedSlots: { file_path: 'src/index.ts' },
    expectedOutcome: 'ok'
  },
  { input: '你能做什么', expectedIntent: 'meta', expectedOutcome: 'meta' },
  { input: '帮我订一张机票', expectedIntent: 'unsupported', expectedOutcome: 'unsupported' }
]

// scorer 输出
interface EvalMetrics {
  top1Accuracy: number       // 意图命中率
  rejectAccuracy: number     // 拒识命中率:reject 用例中报出 unsupported 的比例
  slotCompleteRate: number   // 非拒识用例中必填槽位齐备的比例
}
```

采集 runner 模式:批量跑 headless agent → tap `tools/result` 抓取 `report_intent` 参
→ 喂给 scorer。诚实局限:单轮测用例无法覆盖多轮槽位补全流程,多轮补全率需专项构造
场景。详见 [`references/offline-eval.md`](references/offline-eval.md)。

(回扣准则 5)

## 必做的决策

设计意图识别系统时,需要明确回答以下四个问题:

1. **开放域按需激活 vs 封闭域常开?**
   开放域宿主(如编程 CLI)中意图分类不是每个对话都需要的,「配了才开」避免不必要
   的分类开销。封闭域 agent(客服、运维排查)的每条 user 消息都应走分类,常开是正
   确的默认。规则:如果没有 `intents.yml`,通用层(规范化)仍常驻,只有闭集分类退化。

2. **confidence 阈值取多少?**
   不存在「正确」的单一阈值。经验起点:0.5 作为初始值,再用评估集标定。阈值升高
   → 减少误分类但增加澄清频率;阈值降低 → 反之。必须在真实数据上量化,不凭感觉
   设定。confidence 阈值只驱动进入澄清流程,永远不做执行/拒绝的硬路由。

3. **哪些槽位 ask_user,哪些 auto_fetch?**
   能从上下文自动确定的(当前文件、工作目录、session 状态)→ `source: auto_fetch` 减少打扰。
   需要用户主观意图才能确定的(模糊范围、操作对象) → `source: ask_user`。两者在 `intents.yml`
   的 `source` 字段里声明,不靠运行时模型判断。

4. **评估集怎么建?**
   从真实用户输入采样 + 构造覆盖边界/拒识/模糊的用例,人工标注 `expectedIntent` +
   `expectedSlots`。最小可用评估集:每个意图 ≥ 3 条,拒识用例(unsupported/unclear)
   ≥ 5 条。评估集随意图集版本一起管理,每次调整 `intents.yml` 后重跑 scorer 对比。

## 最简模式

最小可用实现只需三件事:一个 `intents.yml`、一个 `report_intent` 工具、一个
`evaluateClassification` 纯函数。

```typescript
// 最简入口
function injectIntentRecognition(ctx: AgentContext, specPath: string): void {
  const spec = loadIntentSpec(specPath)          // 读 intents.yml
  ctx.tools.register(makeReportIntentTool(spec)) // 注册 report_intent
  // evaluateClassification 在 report_intent.execute 里调用
}

// 最简判定 (不含 confidence 阈值,只判结构)
function evaluateClassification(
  result: ClassificationResult,
  spec: IntentSpec
): EvalDecision {
  // 未知意图名先规范化:不在枚举里的 → 'unclear'
  const intent = normalizeIntent(spec, result.intent)

  const reserved = ['meta', 'unsupported', 'unclear']
  if (reserved.includes(intent)) {
    return { outcome: intent as Outcome }
  }
  const requiredSlots = getRequiredSlots(spec, intent)
  const actualMissing = requiredSlots.filter(s => !result.slots[s])
  return actualMissing.length > 0
    ? { outcome: 'missing_slots', missing: actualMissing }
    : { outcome: 'ok', intent, slots: result.slots }
}
```

`intents.yml` schema 见 [`references/intent-spec-schema.md`](references/intent-spec-schema.md)。
`ClassificationResult` / `Outcome` / `EvalDecision` 类型及完整判定逻辑(含 meta 分支、
缺槽重算、confidence 阈值)见 [`references/classification-contract.ts`](references/classification-contract.ts)。

## 两类应用场景

同一套判定内核,只换激活方式,就能覆盖两类截然不同的 agent。真实落地代码见
[`references/real-world-case.md`](references/real-world-case.md)。

### 场景 A:开放域宿主(编程 CLI)

典型例子:软件开发助手。用户输入既有「帮我看看这段代码」也有「你支持什么命令」,
意图分类只对前者有价值。

- **激活方式**:「配了才开」。宿主发现 `intents.yml` 时加载意图分类;没有配置时通
  用层(词汇表规范化)仍常驻,只有闭集分类退化。
- **保留意图价值在此最大**:元问题(「你会什么」「这是什么工具」)在此类 agent 里
  比例高,meta 出口防止它们被误判成超范围任务。
- **通用层常驻**:即使没有意图分类,规范化(词汇表注入 + 模糊澄清)对提升所有对
  话质量都有价值,不应与闭集分类绑定开关。

### 场景 B:封闭域 agent(客服/运维排查)

典型例子:企业运维排查助手,仅支持有限的排查意图(查日志、重启服务、检查健康等)。

- **激活方式**:常开。每条 user 消息都走分类。`intents.yml` 是服务边界的显式声明。
- **拒识出口价值在此最大**:超出支持范围的请求(如「帮我写邮件」)必须被 unsupported
  礼貌截停,不能被宿主模型凭直觉「发挥」。
- **槽位填充比例高**:排查意图通常有多个必填参数(服务名、时间范围、环境),槽位
  补全链路是核心用户体验,需要精心设计每个槽位的 `source` 字段。

两类场景的 `evaluateClassification` 逻辑、fail-open 安全、三出口判定**完全一致**,
差异只在 `intents.yml` 的激活时机和 confidence 阈值取值。

## 边界

本技能负责:
- 意图识别方法论:闭集分类设计、出口判定逻辑、槽位补全策略
- `intents.yml` schema 设计(版本/槽位/意图/保留意图/fewshot)
- `evaluateClassification` 纯函数内核的设计原则
- 离线评估体系:指标定义、评估集管理、采集 runner 模式
- 两类应用场景的激活策略差异

本技能不负责:
- 某个具体第三方插件的安装与运行(由使用方按其项目文档处理)
- 具体领域的意图集设计(领域知识在使用方,方法论在本 skill)
- 宿主 agent loop 实现(见 `production-agent-loop` 技能)
- LLM 选型与模型参数调优

## 反模式

以下做法违反上述准则,在生产中都导致过真实事故:

**1. 开放生成意图名(违准则 1)**
允许模型自由生成意图名而非从枚举选取。后果:模型随输入波动创造不同的意图名变体
(`debug_perf` / `performance_debug` / `perf_issue`),下游路由找不到 handler,静默
失效或 crash。修复:意图集必须外化为枚举,工具 schema 里的 `intent` 字段加 `enum`
约束,不匹配时直接按 unclear 处理。

**2. confidence 硬路由(违准则 4)**
用模型自报的 `confidence` 做 `> 0.7 → 执行,≤ 0.7 → 拒绝` 这种硬路由。后果:
模型的 confidence 自评不可靠,高 confidence 的错误分类会绕过所有保护直接执行,低
confidence 的正确分类反而被拒。修复:confidence 只驱动澄清追问,不做执行/拒绝决策。

**3. 信模型自报 missing_slots(违准则 4)**
直接使用 `result.missing_slots` 决定补全哪些槽位。后果:模型有时漏报、有时多报,
导致补全逻辑不稳定——该问的没问,不该问的多问。修复:永远用 spec 必填集重算,
`missing_slots` 仅供调试参考。

**4. 元问题误判成 unsupported(违准则 2)**
「你能做什么」「这个工具怎么用」被分类成 unsupported 然后礼貌拒识。后果:用户完全
困惑,无法探索 agent 能力边界。修复:meta 出口先判并短路,元问题由宿主正常作答。

**5. 无评估集凭感觉调(违准则 5)**
靠主观印象和零散用户反馈判断意图识别质量,每次调 prompt 或词汇表后无法量化影响。
后果:改进方向凭运气,无法对比回归,难以量化退化。修复:先建最小评估集(每意图
≥ 3 条),每次调整后跑 scorer 对比指标。

**6. pre-step 返回 reject 打断(违 fail-open)**
pre-step hook 检测到没有分类请求时,直接返回 error 或阻断 agent 继续执行。后果:
任何意图识别链路的临时故障(spec 读取失败、工具注册失败)都会造成整个 agent 不可
用。修复:pre-step 只追加软性提示,分类失败时降级到通用流程,绝不 reject。

## 需要更多细节时

- 读 [`references/real-world-case.md`](references/real-world-case.md)
  当你需要从理论到代码的桥:dsh-intent 的 `intents.ts`(规范化注入)、`classify.ts`
  (`report_intent` 工具)、`inject.ts`(接线壳)、`score.ts`(离线评估)逐模块解剖。
- 读 [`references/intent-spec-schema.md`](references/intent-spec-schema.md)
  获取 `intents.yml` 的完整字段契约:version/slots(数组+globalRequired)/intents[].boundary/
  intents[].fewshot/保留意图约束,以及版本迁移规则。
- 读 [`references/classification-contract.ts`](references/classification-contract.ts)
  获取 TypeScript 参考类型(`ClassificationResult` / `Outcome` / `EvalDecision` /
  `IntentSpec` / `ClassificationConfig`)及带注释的 `evaluateClassification` 完整实现,
  含 `normalizeIntent`、meta 短路分支、缺槽重算、`confidenceFloor` 阈值逻辑。
- 读 [`references/offline-eval.md`](references/offline-eval.md)
  获取三指标定义与计算方式、采集 runner 模式详解,以及「单轮测用例无法覆盖多轮槽位
  补全」的诚实局限与应对策略。
