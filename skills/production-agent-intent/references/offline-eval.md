# 离线评估

离线评估是意图识别质量的可量化基线。评估集由 YAML 格式的测试用例组成,三个核心指标由 `scorePredictions` 纯函数计算——不依赖 agent 运行时,可在 CI 中独立跑。

---

## 三指标定义与计算口径

`scorePredictions(cases, preds)` 接收测试用例列表和采集到的预测列表,返回 `ScoreReport`。三个指标的计算口径如下。

### top1Accuracy — 意图命中率

```
top1 = 预测 intent === expect.intent 的用例数
top1Accuracy = ratio(top1, cases.length)
```

统计所有用例(含拒识用例)中意图完全匹配的比例。拒识用例的 `expect.intent` 通常为 `'unsupported'`,预测值也必须为 `'unsupported'` 才算命中——这意味着 `top1Accuracy` 同时衡量正常意图识别和拒识识别的综合命中。

### rejectAccuracy — 拒识准确率

```
rejectTotal = expect.reject === true 的用例数
rejectHit   = rejectTotal 中预测 intent === 'unsupported' 的数量
rejectAccuracy = ratio(rejectHit, rejectTotal)
```

只统计显式标注 `reject: true` 的用例,衡量 agent 对超范围请求报出 `'unsupported'` 的命中率。若评估集中没有任何拒识用例(`rejectTotal === 0`),`ratio` 返回 `1`(见下方「空集满分」说明)。

### slotCompleteRate — 槽位完整率

```
slotCaseTotal   = expect.reject !== true 的用例数(非拒识用例)
slotCompleteHit = 其中预测的 missing_slots.length === 0 的数量
slotCompleteRate = ratio(slotCompleteHit, slotCaseTotal)
```

只统计非拒识用例,衡量首次分类时预测结果中必填槽位无缺漏的比例。注意这里衡量的是**预测端**的 `missing_slots` 是否为空,而非 agent 最终是否补全了槽位(见「诚实局限」节)。

### ratio 空集满分语义

```typescript
const ratio = (hit: number, total: number): number => (total === 0 ? 1 : hit / total)
```

当分母为 0 时,`ratio` 返回 `1` 而非 `NaN` 或报错。语义:「评估集中没有此类用例」视为满分——空集上无法判断质量问题,不应因为覆盖缺失拉低整体得分。实践中应确保每类用例都有足够覆盖,而非依赖这个默认值。

---

## eval-cases YAML 格式

评估集写成 YAML,顶层必须是对象,`cases` 字段必须是非空数组。`parseEvalCases` 会做 fail-fast 校验:顶层非对象、`cases` 缺失或为空、任意用例缺 `input` 或 `expect.intent`,均直接抛错。

```yaml
cases:
  # 普通意图用例:只需 input + expect.intent
  - input: 帮我解释一下 src/index.ts 的逻辑
    expect:
      intent: explain_code

  # 另一个普通意图用例
  - input: 跑一下测试
    expect:
      intent: run_tests

  # 拒识用例:需要额外标注 reject: true
  # intent 填 'unsupported',scorer 按 rejectAccuracy 口径单独统计
  - input: 帮我订一张到上海的机票
    expect:
      intent: unsupported
      reject: true

  # 元问题用例:没有 reject 标注,走普通意图命中逻辑
  - input: 你能做什么
    expect:
      intent: meta
```

字段说明:

| 字段 | 类型 | 必须 | 说明 |
|---|---|---|---|
| `input` | `string` | 是 | 非空。喂给 agent 的原始用户输入 |
| `expect.intent` | `string` | 是 | 非空。期望的意图名;拒识用例填 `'unsupported'` |
| `expect.reject` | `boolean` | 否 | `true` 时该用例进入 `rejectAccuracy` 统计;缺省则进入 `slotCompleteRate` 统计 |
| `expect.slots` | `Record<string, unknown>` | 否 | 期望的槽位值;当前 scorer 不使用此字段计算指标,可用于人工审查 |

---

## 采集 runner 模式

scorer 只接受 `Prediction[]`——每条预测需要从 agent 运行结果中提取。采集流程:

1. **headless 批跑**:以 `dsh headless`(或等价的无交互模式)按评估集逐条跑 `input`。
2. **tap `tools/result` 扩展点**:dsh 在工具调用完成时向 `tools/result` 发射事件,payload 即工具参数。挂监听器拦截所有 `report_intent` 调用的参数:
   ```typescript
   ctx.on('tools/result', ({ name, args }) => {
     if (name === 'report_intent') {
       predictions.push({
         input: currentInput,    // 与当前用例的 input 对应
         intent: args.intent,
         missing_slots: args.missing_slots ?? [],
       })
     }
   })
   ```
3. **转成 `Prediction[]`**:收集完所有预测后喂给 `scorePredictions(cases, predictions)`。
4. **输出 `ScoreReport`**:打印或写入文件,与历史基线对比。

runner 需要维护 `input → prediction` 的映射——`scorePredictions` 内部按 `input` 做 Map 查找,若某条用例没有对应预测,该用例的所有指标均不计为命中(不报错,静默未命中)。

---

## 诚实局限:单轮测不了槽位完整率

单轮批量采集只能观测到**首次分类时 `report_intent` 参数里的 `missing_slots`**——即 agent 在第一轮判断出哪些必填槽位缺漏。这和「用户最终补全了多少槽位」是两件不同的事。

槽位完整是**多轮现象**:首轮报告缺槽 → agent 追问 → 用户提供 → 下一轮重分类才能看到 `missing_slots` 清空。单轮测用例在首轮就结束,捕获不到补全过程——看到的 `slotCompleteHit` 只代表「首次分类时恰好没有缺槽」,而非「槽位补全链路跑通了」。

因此:

- **`top1Accuracy` 和 `rejectAccuracy` 是单轮可信信号**:它们只依赖首轮的 `intent` 字段,不受多轮状态影响。
- **`slotCompleteRate` 在单轮集上偏低是正常的**:输入越模糊、必填槽位越多,首轮命中率自然低——这反映的是用例设计,不是 agent 缺陷。

实测中 Top-1 和拒识均可达到较高命中率,而 `slotCompleteRate` 明显偏低(如 16.7%),即此原因。

若需要量化多轮槽位补全的端到端通过率,需要专项构造多轮对话用例,并改用能追踪跨轮状态的 runner——这超出当前单轮评估集的能力范围,属于下一步扩展项。
