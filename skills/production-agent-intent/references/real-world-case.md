# dsh-intent 落地印证

本文档逐模块讲 `@webb/dsh-intent` 插件**真实实现**的意图识别:每个能力对应哪个模块/函数、代码怎么组织、边界划在哪。这是 SKILL.md 五准则与工作流的代码印证。

案例模块:`classify`、`config`、`detect`、`glossary`、`index`、`inject`、`intents`、`score`。

---

## 0. 配置层(config.ts)

`config.ts` 用 `@deepseek-ai/schemastery` 的 `z.object()` 声明 schema,导出四个配置接口,所有字段有默认值,团队零配置可用:

- `GlossaryConfig` — 词汇表根目录、项目根标记、注入字数上限
- `ClarifyConfig` — 模糊动词列表、短输入阈值
- `ClassificationConfig` — `enabled`、`specRoot`、`confidenceFloor`(默认 `0.6`)、`reclassifyNudge`
- `IntentConfig` — 汇总前三个 + 顶层 `enabled`

**边界**:`confidenceFloor=0.6` 是可调起点而非写死,但阈值标定流程不在插件内——插件负责执行策略,标定责任在消费方。

---

## 1. 输入规范化(glossary.ts + detect.ts + inject.ts)

分类前先消解脏输入(准则 3)。dsh-intent 做两件事:词义消解 + 模糊输入澄清。

### 词义消解(glossary.ts + inject.ts buildGlossaryMessage)

`glossary.ts` 维护项目词汇表文件(`GLOSSARY.md`):

- `deriveProjectRoot` 向上遍历目录树,按 `projectRootMarkers`(`.git` / `package.json` / `pnpm-workspace.yaml`)定位项目根,找不到降级到 `cwd`。
- `parseGlossary` 按固定格式(`- **术语**: 释义 (scope: personal/public)`)解析词条。
- `loadGlossaryText` / `saveGlossary` 读写;`upsertEntry` / `removeEntry` 原子操作词条。
- `glossaryFile` 拼出完整文件路径。

`inject.ts` 的 `buildGlossaryMessage` 把词汇表文本包装为 `UserMessage`,`source.form='snapshot'`(快照语义,重开会话重注入)。超 `maxInjectChars` 时尾部截断并附注「词汇表过长已截断」。

词汇表在 `agent/session-start` 注入(resume 跳过)。`define_term` / `forget_term` 工具暴露给模型,支持对话中沉淀新术语——模型主动调工具写入。

### 模糊输入启发式(detect.ts + inject.ts buildClarifyMessage)

`detect.ts` 的 `detectUnderspecified` 是一个三条件「与门」:

```
hasVague（含模糊动词）
  AND isShort（词数 ≤ maxWordsForShort）
  AND !hasReference（无具体引用:路径/代码块/函数调用/符号）
```

三条件全满足才标记 `flagged`;任何一个不满足(如「优化但附了文件路径」)直接放行,避免过度澄清。`roughWordCount` 粗略计词:CJK 逐字计,非 CJK 按空白分割——仅用于「短输入」启发式,不求精确。

`augmentPreStep` 在 `agent/pre-step` 内调用:命中时把 `buildClarifyMessage` 构造的引导追加到批次末尾,返回修改后的 `PreStepDecision`;不命中或工具续跑(无新用户输入)原样返回。`buildClarifyMessage` 的 `source.form='notice'`(通知语义,比 snapshot 轻量)。

**边界**:模糊检测**仅在通用模式(无 intents.yml)下激活**(见第 4 节 `domainMode`)。领域模式下 spec 本身承担结构化引导,不再跑通用启发式。指代消解、主观判断量化、外部事实补全都不做——要么需跨轮记忆/属性检索超出单插件边界,要么该由宿主 Agent 在 ReAct 循环里决策。

---

## 2. 闭集分类(intents.ts + inject.ts + report_intent 工具)

意图只从枚举清单选,绝不发明(准则 1)。

### spec 解析与校验(intents.ts)

`intents.ts` 是意图定义的信任锚点:

- `parseIntentSpec` 解析并校验 YAML:`version` 必须为 `1`(硬校验,不静默降级);每个意图必须有非空 `desc`;意图名不得与 `RESERVED_INTENTS`(`['unclear','unsupported','meta']`)冲突;不允许重名。
- `loadIntentSpec` 解析失败返回 `null`(坏 YAML 降级通用模式),不抛异常——fail-open 贯穿始终。
- `specFile` 复用 `deriveProjectRoot`,拼出 `intents.yml` 绝对路径。
- `requiredSlotsFor` 合并全局必填(`globalRequired=true`)和意图级必填(`required=true`)。
- `slotSource` 查某槽位来源:先查意图本地,再查全局。
- `legalIntentNames` 合并业务意图名 + `RESERVED_INTENTS`。

类型:`IntentSpec`(顶层)→ `IntentDef`(单意图,含 `slots?: Slot[]` 和 `fewshot?: FewShot[]`)→ `Slot`(含 `source: SlotSource`,区分 `'ask_user'` / `'auto_fetch'`)→ `FewShot`。

### 意图 spec 注入(inject.ts buildIntentSpecMessage)

`buildIntentSpecMessage` 把 spec 序列化注入为 `UserMessage`,有四级截断降级:

1. 完整头(`INTENT_HEADER`)+ 意图列表 + few-shot → 优先
2. 放不下 → 丢 few-shot,保完整头 + 意图列表
3. 仍放不下 → 换精简头(`INTENT_HEADER_SHORT`,仅保「先调 report_intent,只从下列意图选」)
4. 连精简头 + 意图列表都超 → 硬截意图列表尾部

核心 directive(「必须先调 report_intent」「不许发明意图」「信息不足选 unclear」「超范围选 unsupported」「元问题选 meta」)在前三级始终保留;极端情况才牺牲部分意图清单,头部优先保住。`serializeIntentSpec` 是不含截断的完整版本,供离线 diff/调试。

`buildClassifyGuideMessage` 把 `evaluateClassification` 产生的 `reasons` 组装成引导:区分 `ask_user`(向使用者追问)vs `auto_fetch`(查日志/调工具补齐),`unsupported` 说明超范围,`low_confidence` 亮出候选请确认。`buildReclassifyNudge` 是「还没调 report_intent」的简短提醒,在 `pre-step` 注入。

### report_intent 工具

`report_intent` 在 `index.ts` 的 `domainMode` 分支注册,参数:`intent`(候选名或保留意图)、`slots`(已抽取键值)、`missing_slots`(模型自填,插件会重算)、`confidence`(自评 `[0,1]`)。`execute` 调 `evaluateClassification` 得 `EvalDecision`;`reasons` 非空则调 `exec.deferContext(buildClassifyGuideMessage(...))` 延迟注入引导;返回结构化文本摘要。

**边界**:三层识别机制塌缩为单层——宿主模型既是分类器又是深度推理者,没有独立规则引擎/向量检索/多识别器仲裁。理由:宿主是 DeepSeek 系 LLM,推理能力已是深度水位;意图集小(通常 10-30 个),省去中间环节换零基础设施依赖。few-shot 静态(存 `intents.yml` 随 spec 注入),无动态检索注入。

---

## 3. 判定内核(classify.ts)

最终判定全在纯函数里,不信模型自评(准则 4);三个保留意图 `meta`/`unsupported`/`unclear` 即准则 2 的三个诚实出口,在此优先级链里落地。

### evaluateClassification 优先级链

接受 `spec`、模型提交的 `ClassificationResult`(`intent`/`slots`/`missing_slots`/`confidence`)和 `confidenceFloor`,按固定优先级返回 `EvalDecision`:

```
1. normalizeIntent → 非法意图名映射到 'unclear'
2. intent === 'meta'        → { outcome: 'meta', reasons: [] }   // 短路,空 reasons,不注入引导
3. intent === 'unsupported' → { outcome: 'unsupported', ... }
4. intent === 'unclear'     → { outcome: 'unclear', ... }
5. confidence < confidenceFloor → { outcome: 'low_confidence', ... }
6. computeMissingSlots 非空 → { outcome: 'missing_slots', reasons }
7. → { outcome: 'ok', reasons: [] }
```

`normalizeIntent` 用 `legalIntentNames(spec)` 判合法性,非法归 `unclear`——分类后的代码校验,防模型无中生有(准则 1 的兜底)。`meta` 短路在置信度和槽位检查**之前**:元问题(闲聊/问能力/打招呼)不触发任何补全引导,直接空 reasons,模型正常作答即可。

### computeMissingSlots 重算

从 spec 重算必填槽位,不信模型自填的 `missing_slots`:

```
requiredSlotsFor(spec, intent).filter(name => isEmpty(slots[name]))
```

发现缺失后按 `slotSource` 分两组:`ask_user`(告知「向使用者追问」)、`auto_fetch`(告知「查日志/调工具补齐,别问人」)。这个分流避免把本该工具补全的参数错误地追问用户。

**边界**:槽位统一 key-value,不建模硬/软约束(约束语义交模型推断);每次 `report_intent` 独立评估,无跨轮槽位状态追踪;confidence **不**升级到更深层模型——仅驱动 `low_confidence` 出口,因宿主模型已是高推理水位。

---

## 4. 接线激活(index.ts)

纯函数内核靠薄接线接入宿主(准则 4 的架构落地),fail-open 铁律贯穿。

### domainMode 激活门

```typescript
const domainMode = config.classification.enabled && existsSync(specPath)
```

`apply` 时同步探测 `intents.yml`:存在则领域模式,否则行为与 v0.1.0 逐字节等价(仅词汇表 + 模糊澄清)。**配了才开**。`specFile` 用 `deriveProjectRoot` 找根,路径 `<root>/<specRoot>/intents.yml`(`specRoot` 默认 `.dsh-intent`)。

### agent/session-start 双钩子

1. **词汇表注入**(始终注册):读词汇表文件,调 `buildGlossaryMessage` 注入。resume 跳过。
2. **spec 加载 + 注入**(仅 `domainMode`):`loadIntentSpec` 加载,成功调 `buildIntentSpecMessage` 注入并写会话级 `spec`;失败 `spec=null` 降级并 warn。

两监听器独立,各自 try/catch 兜底。

### agent/pre-step 双分支

```
if (spec) { /* 领域:仅 reclassifyNudge,每轮至多一次 */ }
else      { /* 通用:augmentPreStep 模糊澄清 */ }
```

领域模式:`reclassifyNudge=true` 且当前 turn 未追过 nudge、决策类型 `enter`(有新输入)、消息非空时,追加 `buildReclassifyNudge()`;`nudgedTurns` 集合确保每轮只 nudge 一次;工具续跑不触发。整个 handler 外包 try/catch,异常返回原始 `decision`——**绝不 reject**。

### deferContext

`report_intent` 的 `execute` 中,`evaluateClassification` 返回非空 `reasons` 时调 `exec.deferContext(buildClassifyGuideMessage(decision.reasons))`——延迟注入下一推理步,不阻断当前工具返回:模型先收工具结果,再在下一步看引导。`meta` 和 `ok` 空 reasons,不触发。

**边界**:无意图路由到子 Agent(分发交宿主);无按意图动态换 spec(一项目一份,会话内复用同一 `spec`);无状态机(`spec` 是简单会话级变量)。

---

## 5. 评估(score.ts)

质量必须可量化(准则 5)。

`scorePredictions` 接受 `EvalCase[]`(`parseEvalCases` 解析的 YAML 用例)和 `Prediction[]`(实际运行结果),返回 `ScoreReport` 三指标:

```
top1 / top1Accuracy                意图命中(输出 intent === 期望 intent)
rejectHit / rejectAccuracy         拒识命中(expect.reject=true 的用例,预测为 'unsupported')
slotCompleteHit / slotCompleteRate 槽位完整率(非拒识用例中 missing_slots.length === 0 的比例)
```

`ratio` 辅助处理除零:`total === 0 ? 1 : hit / total`(空集视为满分)。`parseEvalCases` 验证 YAML:顶层非空 `cases` 数组,每条有非空 `input` 和 `expect.intent`;格式错抛异常(fail-fast)。

**边界**:只保留这 3 个聚合指标,覆盖 spec 调优最需要的信号(意图对不对、拒识有没有漏、必要信息齐不齐)。分意图准确率、槽位值准确率、约束识别、澄清收敛率、在线反馈都不做——要么需按意图/字段分组比对,要么是运行时动态行为离线不可及,留给消费方基于 `Prediction[]` 自行扩展。

> **单轮采集的诚实局限**:`slotCompleteRate` 在单轮批量采集里天然偏低——槽位补全是多轮现象(第一轮报缺、后续轮补齐),单轮跑只能看到「首次分类时缺多少」。实测 top1/拒识才是单轮可信信号,槽位完整率需多轮会话才有意义。
