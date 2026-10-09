# 采集生命周期契约

本文件定义框架无关的 Agent 可观测性采集生命周期。宿主可以是任意 Agent 框架；只要它
能提供事件流和生命周期钩子，就能按本契约接入采集器。

---

## 1. emit — 每事件即时缓冲

采集器在宿主事件流的每个事件触发时被调用。**核心约束：emit 路径必须是同步的、非阻塞的。**

- 只允许把事件追加到内存队列 / 缓冲区，或追加写入日志文件（单次追加写，不 await flush）。
- **禁止在 emit 内做任何 sync IO（读文件、数据库查询）或 await 异步调用**。
  违反此约束会在 agent 的每步之间引入延迟，破坏主循环的实时性。
- **Logs 是唯一可以在 emit 阶段写盘的产物**：以追加模式写一行 NDJSON。
  单写者顺序 append 具有崩溃一致性（已成功写入的行在崩溃后保留），大负载无需额外锁。
  Traces 和 Metrics 必须在 flush 阶段投影，不在 emit 写。
- **异常隔离**：若宿主事件总线使用 stop-on-throw 策略（任意监听器抛出即中止事件分发），
  采集器的每个 handler 必须自包含 `try/catch`，保证采集侧的任何异常
  不外泄到 agent loop。示意：

  ```js
  eventBus.on('tool/call', (evt) => {
    try {
      buffer.push(evt)            // 只入队，不 IO
      logStream.write(toNdjson(evt) + '\n')  // 追加写，不 await
    } catch {
      // 静默降级，绝不上抛
    }
  })
  ```

---

## 2. flush — 轮末持久化检查点

宿主在每轮（turn）结束时调用 `flush`，将内存缓冲投影为 Traces 和 Metrics 并全量写盘。

### 为什么全量重写

Traces/Metrics 是事件缓冲的纯函数派生物；全量重写比增量追加更简单、更不容易产生
不一致（断电/崩溃不留残缺中间态）。每轮写完后，即使进程未退出，产物也已经是最新的；
常驻服务进程不需要等到 shutdown 才可见。

### coalesce — 单次在写

并发场景（如宿主在前一次 flush 尚未完成时再次触发）必须用 coalesce 避免并发写坏文件。
状态机使用两个标志：`writing`（写操作进行中）和 `dirty`（flush 期间有新事件到来）。
关键不变式：整个 flush 函数必须是可 await 的——调用方 `await flush()` 时，
所有可能触发的补写都在 resolve 前完成。

```js
let writing = false
let dirty = false

async function flush() {
  if (writing) {
    dirty = true    // 标记"写完还要再写一次"
    return
  }
  writing = true
  try {
    do {
      dirty = false
      const snapshot = projectFromBuffer(buffer)    // 纯函数，无副作用
      await atomicWrite('trace.json', snapshot.trace)
      await atomicWrite('metrics.json', snapshot.metrics)
    } while (dirty)   // 写完仍 dirty 则再写一次，保证最终一致
  } finally {
    writing = false
  }
}
```

coalesce 保证：
1. 任意时刻最多一次写操作在执行。
2. flush 期间积累的变更不丢失——写完仍 dirty 则再写一次。
3. 多次密集调用最多额外触发一次写，不无限堆积。
4. `await flush()` 等待所有补写完成后才 resolve，shutdown 可安全依赖它。

---

## 3. shutdown — 进程退出最终写

宿主在进程退出前 `await dispose(collector)`（或等价的清理钩子）。

**顺序严格固定，不可调换：**

1. **先 await 任何进行中的 flush**：若 `writing === true`，等它完成，确保
   当前轮的产物已落盘。
2. **做最后一次投影**：`await flush()` 将截至退出前的全部缓冲写盘，包含进程中最后一轮
   （可能 flush 尚未被宿主触发）的数据。flush 必须是完全可 await 的（含 coalesce 补写），
   确保最后一次投影真正完成后才进入步骤 3。
3. **关闭日志流**：最后才关闭 NDJSON 写入流，保证所有 emit 阶段的日志行都已刷盘。

```js
async function dispose() {
  if (writing) await waitUntilNotWriting()   // 步骤 1
  await flush()                               // 步骤 2：最后一次投影
  await logStream.close()                     // 步骤 3：关日志流
}
```

任何失败静默降级：shutdown 失败不应导致宿主进程以非零码退出或抛出给调用方。

---

## 4. callId 配对算法

tool span 的开始与结束事件必须按 `callId` 配对，**不能用 FIFO**。

### 为什么 FIFO 是错的 — 最小反例

设两个工具并行发起：

```
t=0  tool/call  A  callId=001   ← A 先开始
t=1  tool/call  B  callId=002   ← B 后开始
t=3  tool/result B callId=002   ← B 先完成  ⚠
t=5  tool/result A callId=001   ← A 后完成
```

若按 FIFO（"谁先开，谁先配结果"）：

- 第一个 `tool/result`（B，t=3）被配给第一个 `tool/call`（A，t=0）
  → A 的时长算成 3ms，实际是 5ms；B 的时长算成 2ms，实际是 2ms，但 span 标签互换了。
- 结果：A 和 B 的 span 时长和归属全部错配。

### 正确做法：Map\<callId, startEvent\>

```js
const openSpans = new Map()   // key: callId, value: tool/call 事件

eventBus.on('tool/call', (evt) => {
  openSpans.set(evt.callId, evt)     // 记录开始点
})

eventBus.on('tool/result', (evt) => {
  const start = openSpans.get(evt.callId)
  if (start) {
    const durationMs = evt.timestamp - start.timestamp
    closeSpan(start, evt, durationMs)   // 用 callId 精确配对
    openSpans.delete(evt.callId)
  }
  // 若 start 不存在：孤立 result，记录为警告，不崩溃
})
```

**未闭合 span 处理**：shutdown 时若 `openSpans` 非空，以当前最大已知时间戳
补一个合成结束事件，避免悬空 B-span 导致时间线渲染错乱（Chrome Trace/Perfetto 会容忍悬空 B-span，但时间线可能错乱）。

---

## 5. 多 session — 单进程多 session 共存

一个进程可能同时持有多个 session（例如主 agent 通过 spawn 启动子 agent，双方共用同一个
进程内的采集器实例）。

**三产物以 `runId` 为顶级组织单位**，不按 session 拆子目录。session 维度通过字段区分：

| 产物 | session 区分方式 |
|---|---|
| Logs（NDJSON） | 每行 `attributes['session.id']` 字段 |
| Traces（Chrome Trace） | `pid` 字段（每个 session 使用不同的 `pid` 值） |
| Metrics（聚合 JSON） | `sessions` 对象的分桶键（`sessions[sessionId]`） |

这样做的好处：

- 整个 run 只有一套文件路径，不需要协调多个子目录的写锁。
- 查看器可以一次加载全部 session 的轨迹，便于跨 session 时序对比。
- jq 过滤单个 session：`jq -c 'select(.attributes["session.id"]=="ses-001")' logs.ndjson`

**子 agent spawn 场景**：若子 agent 在独立进程中运行，它拥有独立的 runId 和产物目录；
父 agent 的 Logs 中记录 `spawn` 事件，通过 `attributes['child.runId']`（示意字段名，非强制契约）关联，
不要求跨进程合并产物。跨进程可观测性属于部署级关联，超出本契约范围。
