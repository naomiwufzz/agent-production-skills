/**
 * classification-contract.ts
 *
 * 参考类型文件 —— 展示一个闭集意图分类器的契约与判定逻辑。
 * 带教学注释，非可编译产物。
 *
 * 这是一个独立的教学参考实现，不要求依赖特定插件或宿主。
 *
 * 依赖说明（来自 intents.ts）：
 *   - IntentSpec        : 意图规格对象（含 version/slots/intents 三块）
 *   - requiredSlotsFor  : 返回某意图的必填槽位名称列表（globalRequired + required 合并去重）
 *   - slotSource        : 返回某槽位的填充来源 'ask_user' | 'auto_fetch'
 *   - legalIntentNames  : 返回 spec 内所有合法意图名（业务意图 + 三个保留字）的 Set
 */

// ─────────────────────────────────────────────
// § 1  类型定义
// ─────────────────────────────────────────────

/**
 * LLM 分类器返回的原始结果。
 * 注意 missing_slots 字段是模型自报的，在 evaluateClassification 里会被 spec 重算覆盖。
 */
export interface ClassificationResult {
  intent: string
  slots: Record<string, unknown>
  /** 模型自报的缺槽列表；判定时以 computeMissingSlots 重算，不直接信任此值 */
  missing_slots: string[]
  confidence: number
}

/**
 * 判定出口，共 6 个值（闭集）。
 *
 * 设计动机（准则 2 —— 诚实出口）：
 *   每个出口含义精确、互斥，下游分支逻辑得以零歧义：
 *   - 'ok'            : 意图合法 + 置信度达标 + 必填槽全齐 → 可直接执行
 *   - 'meta'          : 非任务型（闲聊/元问题）→ 正常作答，不注入引导
 *   - 'unsupported'   : 意图在识别集合内但明确超出本领域支持范围 → 礼貌拒绝
 *   - 'unclear'       : 意图信息不足（包括非法意图名被规范化后的结果）→ 追问
 *   - 'low_confidence': 意图本身合法但模型把握度低 → 让用户确认候选
 *   - 'missing_slots' : 意图明确但必填槽缺失 → 按 reasons 追问/自动补齐
 */
export type Outcome =
  | 'ok'
  | 'meta'
  | 'unsupported'
  | 'unclear'
  | 'low_confidence'
  | 'missing_slots'

/**
 * evaluateClassification 的返回值。
 * reasons 为空数组时表示无需额外上下文（如 'ok' 和 'meta'）。
 */
export interface EvalDecision {
  outcome: Outcome
  reasons: string[]
}

// ─────────────────────────────────────────────
// § 2  辅助函数
// ─────────────────────────────────────────────

/**
 * 将 LLM 返回的 intent 名规范化到合法集合。
 *
 * 准则 1（闭集有界）：IntentSpec 是设计时确定的闭集；LLM 是概率模型，
 * 可能输出训练数据里见过但 spec 未声明的字符串。
 * 凡不在 legalIntentNames(spec) 内的意图一律归 'unclear'，
 * 而非透传给下游——防止下游 switch/if 链出现意外分支。
 */
export function normalizeIntent(spec: IntentSpec, intent: string): string {
  // legalIntentNames 返回 业务意图名 ∪ {'unclear','unsupported','meta'}
  return legalIntentNames(spec).has(intent) ? intent : 'unclear'
}

/**
 * 槽位空值判定：null / undefined / 空字符串 均视为"未填"。
 * （内部辅助，不导出）
 */
const isEmpty = (v: unknown): boolean => v === null || v === undefined || v === ''

/**
 * 按 IntentSpec 重算缺失的必填槽位。
 *
 * 准则 4（确定性内核）：LLM 的 missing_slots 自报不可靠（可能漏报、多报）。
 * 以 spec 为唯一权威：requiredSlotsFor 取 globalRequired ∪ 意图级 required，
 * 再对 slots 实际值做 isEmpty 过滤——spec 说缺就是缺，模型说齐也要核验。
 */
export function computeMissingSlots(
  spec: IntentSpec,
  intent: string,
  slots: Record<string, unknown>,
): string[] {
  return requiredSlotsFor(spec, intent).filter(name => isEmpty(slots[name]))
}

// ─────────────────────────────────────────────
// § 3  核心判定函数 evaluateClassification
// ─────────────────────────────────────────────

/**
 * 对一次分类结果做完整评估，返回 EvalDecision。
 *
 * @param spec            意图规格（唯一事实来源）
 * @param result          LLM 原始分类结果
 * @param confidenceFloor 置信度下限（0-1），由 AgentConfig 注入，不在此硬编码
 *
 * 优先级链（严格按序，遇到匹配立即 return）：
 *
 *   1. normalizeIntent         → 非法意图名 → outcome 'unclear'
 *   2. intent === 'meta'       → 短路返回，**不再检查置信度/槽位**
 *   3. intent === 'unsupported'
 *   4. intent === 'unclear'
 *   5. confidence < floor      → 'low_confidence'
 *   6. computeMissingSlots 非空 → 'missing_slots'
 *   7.                         → 'ok'
 *
 * 为什么 meta 要短路在置信度之前？（准则 2 —— 诚实出口）
 *   meta 表示闲聊/元问题，本就不应执行任务，置信度/槽位完全无关。
 *   短路保证 meta 路径的语义干净，不被误判为 low_confidence。
 *
 * 为什么 confidence 只驱动 low_confidence 而不路由到特定意图？（准则 4 —— 确定性内核）
 *   confidence 是模型的自我评估，不代表意图真实性。
 *   低置信度只说明"需要人确认候选"，不代表意图是 unclear 或 missing_slots。
 *   将两者混淆会让下游看到错误的 outcome 并给出错误的引导话术。
 */
export function evaluateClassification(
  spec: IntentSpec,
  result: ClassificationResult,
  confidenceFloor: number,
): EvalDecision {
  // 步骤 1：规范化意图名。非法名 → 'unclear'（准则 1 —— 闭集有界）
  const intent = normalizeIntent(spec, result.intent)

  // 步骤 2：meta 短路（准则 2 —— 诚实出口；短路在置信度/槽位检查之前）
  // meta = 闲聊/元问题，不需要引导，reasons 保持空数组
  if (intent === 'meta') return { outcome: 'meta', reasons: [] }

  // 步骤 3：超出支持范围
  if (intent === 'unsupported') return { outcome: 'unsupported', reasons: ['超出本领域支持范围'] }

  // 步骤 4：意图不明确（含步骤 1 规范化后落到 unclear 的情况）
  if (intent === 'unclear') return { outcome: 'unclear', reasons: ['意图不明确'] }

  // 步骤 5：置信度不足（准则 4 —— confidence 只驱动此分支，不硬路由到其他出口）
  if (result.confidence < confidenceFloor) {
    return { outcome: 'low_confidence', reasons: ['分类置信度低,候选待确认'] }
  }

  // 步骤 6：槽位缺失（准则 4 —— 以 spec 重算，不信模型自报的 missing_slots）
  const missing = computeMissingSlots(spec, intent, result.slots)
  if (missing.length > 0) {
    // 按填充来源分组：ask_user → 需追问用户；auto_fetch → 可由工具/日志自动补齐
    const ask = missing.filter(n => slotSource(spec, intent, n) !== 'auto_fetch')
    const auto = missing.filter(n => slotSource(spec, intent, n) === 'auto_fetch')
    const reasons: string[] = []
    if (ask.length) reasons.push(`缺(问客服): ${ask.join('、')}`)
    if (auto.length) reasons.push(`缺(查日志/工具): ${auto.join('、')}`)
    return { outcome: 'missing_slots', reasons }
  }

  // 步骤 7：全部检查通过
  return { outcome: 'ok', reasons: [] }
}

// ─────────────────────────────────────────────
// § 4  类型存根（仅供本文件读者理解依赖形状，非运行时导出）
// ─────────────────────────────────────────────
//
// 以下类型/函数在真实实现里来自 ./intents.ts，本参考文件以存根形式列出，
// 仅作结构说明，不构成实际实现。
//
// export type SlotSource = 'ask_user' | 'auto_fetch'
//
// export interface Slot {
//   name: string
//   source: SlotSource
//   globalRequired?: boolean
//   required?: boolean
// }
//
// export interface IntentDef { name: string; desc: string; slots?: Slot[] }
//
// export interface IntentSpec { version: number; slots: Slot[]; intents: IntentDef[] }
//
// export function legalIntentNames(spec: IntentSpec): Set<string>
//   → 返回 new Set([...spec.intents.map(i => i.name), 'unclear', 'unsupported', 'meta'])
//
// export function requiredSlotsFor(spec: IntentSpec, intentName: string): string[]
//   → 合并 spec.slots 的 globalRequired + 意图级 required，去重后返回名称列表
//
// export function slotSource(spec: IntentSpec, intentName: string, slotName: string): SlotSource | undefined
//   → 优先取意图级槽位的 source，找不到再取全局槽位的 source

// ─────────────────────────────────────────────
// 类型占位（让本文件引用不报 TS 错误；真实实现从 intents.ts 导入）
// ─────────────────────────────────────────────
interface IntentSpec {
  version: number
  slots: Array<{ name: string; source: 'ask_user' | 'auto_fetch'; globalRequired?: boolean; required?: boolean }>
  intents: Array<{ name: string; desc: string; slots?: Array<{ name: string; source: 'ask_user' | 'auto_fetch'; required?: boolean }> }>
}
declare function legalIntentNames(spec: IntentSpec): Set<string>
declare function requiredSlotsFor(spec: IntentSpec, intentName: string): string[]
declare function slotSource(spec: IntentSpec, intentName: string, slotName: string): ('ask_user' | 'auto_fetch') | undefined
