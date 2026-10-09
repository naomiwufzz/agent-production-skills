# 三支柱产物格式契约

本文件定义三类可观测性产物的确切格式。采集实现可以用任何语言或框架，
只要写出符合本契约的文件，现有查看器和查询工具即可无缝消费。

---

## 一、Logs（NDJSON）

每行一条结构化记录，UTF-8 编码，行末 `\n`。文件名约定：`logs.ndjson`。
流式追加写；采集器崩溃时已写行不丢失。

### 字段表

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `channel` | `'ledger'` \| `'ops'` | 是 | `ledger`：来自宿主的权威事件镜像，完整还原 agent 执行历史；`ops`：采集器自身发出的运维信号（启动、flush、错误） |
| `time` | `number` | 是 | Epoch 毫秒（wall clock），宿主事件携带的原始时间戳 |
| `severity` | `'info'` \| `'warn'` \| `'error'` | 是 | 事件的严重程度；宿主事件通常为 `info`，采集器自报错用 `error` |
| `attributes` | `object` | 是 | 结构化索引字段，见下表 |
| `body` | `object` | 是 | 事件负载深拷贝；内容随 `event.type` 变化，采集侧不改写 |

#### `attributes` 必含字段

| 键 | 类型 | 说明 |
| --- | --- | --- |
| `session.id` | `string` | 会话唯一标识，与 Traces 的 `pid` 对齐 |
| `event.type` | `string` | 事件类型，如 `turn/start`、`tool/call`、`turn/end` |
| `event.seq` | `number` | 会话内单调递增序号，用于排序和去重 |

其他属性（如 `session.cwd`、`session.format_version`）由宿主事件携带，透传保留。

### 样例

```jsonl
{"channel":"ledger","time":1751234567890,"severity":"info","attributes":{"session.id":"session-a1b2c3d4","event.type":"turn/start","event.seq":4},"body":{"turn":1}}
```

---

## 二、Traces（Chrome Trace Event Format）

单个 JSON 文件，顶层为 `{ "traceEvents": [...] }`。文件名约定：`trace.json`。
每次 flush 全量重写（幂等）。可直接用 [Perfetto](https://ui.perfetto.dev) 或
`chrome://tracing` 打开。

### 字段表

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | `string` | 是 | span 名称，如 `turn 1`、`step 2`、`read_file`（工具名）|
| `ph` | `'B'` \| `'E'` | 是 | `B`：span 开始；`E`：span 结束，必须成对出现（未闭合时由 flush/shutdown 合成 E 补齐）|
| `ts` | `number` | 是 | 微秒时间戳，`ts = 事件毫秒 × 1000`（Perfetto 要求微秒精度）|
| `pid` | `string` | 是 | 泳道标识，填 `session.id`；一个 session 一条泳道 |
| `tid` | `number` | 是 | 轨道标识，填 turn 序号；一个 turn 一条 track |
| `args` | `object` | 否 | 附加上下文，见映射表 |

### 事件映射表

| 宿主事件 | `ph` | `args` |
| --- | --- | --- |
| `turn/start` | `B` | — |
| `turn/end` | `E` | `{ reasonKind }` |
| `step/start` | `B` | — |
| `step/end` | `E` | — |
| `tool/call` | `B` | `{ callId, arguments }` （arguments 截断至合理长度）|
| `tool/result` | `E` | `{ isError }` |

**tool span 配对规则**：按 `callId` 匹配开-闭，而非 FIFO。
并行工具乱序完成时，FIFO 配对会错配不同工具的 B/E，导致时长失真。

**并行工具注意**：同一 turn 内**并发**的 tool span 无法用共享 track 的 B/E 忠实表示（B/E 在单 `(pid,tid)` 上必须严格 LIFO 嵌套）。若工具在一 turn 内并行执行，应给每个并发调用分配不同的 `tid`（一条 track 一个并发调用），或改用异步相 `ph:'b'/'e'` 配 `id` 字段。callId 配对解决的是采集期时长归属；串行工具下单 track B/E 足够，并行场景须按上述处理。

**未闭合 span 处理**：flush/shutdown 时若存在已有 B 但尚未收到对应 E 的 span，
在当前最晚时间戳（`maxTs`）追加合成的 E 事件，避免悬空 B-span 导致时间线渲染错乱（补 maxTs E 是良好实践，Chrome Trace/Perfetto 会容忍悬空 B-span 并在 trace 末尾自动闭合，但时间线可能错乱）。

### 样例

```json
{
  "traceEvents": [
    { "name": "turn 1", "ph": "B", "ts": 1751234567890000, "pid": "session-a1b2c3d4", "tid": 1 },
    { "name": "step 1", "ph": "B", "ts": 1751234568100000, "pid": "session-a1b2c3d4", "tid": 1 },
    { "name": "read_file", "ph": "B", "ts": 1751234568200000, "pid": "session-a1b2c3d4", "tid": 1, "args": { "callId": "call_abc123", "arguments": "{\"path\":\"/src/index.ts\"}" } },
    { "name": "read_file", "ph": "E", "ts": 1751234568350000, "pid": "session-a1b2c3d4", "tid": 1, "args": { "isError": false } },
    { "name": "step 1", "ph": "E", "ts": 1751234571200000, "pid": "session-a1b2c3d4", "tid": 1 },
    { "name": "turn 1", "ph": "E", "ts": 1751234571250000, "pid": "session-a1b2c3d4", "tid": 1, "args": { "reasonKind": "completed" } }
  ]
}
```

---

## 三、Metrics（聚合 JSON）

单个 JSON 文件，全量重写（幂等）。文件名约定：`metrics.json`。
以 `runId` 为顶层单位，按 session 分桶聚合。

### 完整 Schema

```jsonc
{
  "runId": "string",          // 进程级唯一标识，通常为启动时刻的 ISO 时间戳
  "wallStart": 1751234567890, // 进程首个事件的 epoch ms
  "wallEnd": 1751234572345,   // 进程末个事件的 epoch ms（每次 flush 更新）
  "sessions": {
    "<session.id>": {
      "tokens": {
        "input": 0,           // 输入 token 累计
        "output": 0,          // 输出 token 累计
        "total": 0,           // input + output
        "cacheRead": 0,       // 命中 prompt cache 的 token
        "cacheWrite": 0,      // 写入 prompt cache 的 token
        "reasoning": 0        // 推理（thinking）token
      },
      "counts": {
        "turns": 0,           // 完成的 turn 数
        "steps": 0,           // 完成的 step 数
        "toolCalls": {
          "<tool_name>": 0    // 每个工具的调用次数
        }
      },
      "latencyMs": {
        "turn":  { "p50": 0, "p95": 0, "max": 0, "count": 0 },
        "step":  { "p50": 0, "p95": 0, "max": 0, "count": 0 },
        "tool":  { "p50": 0, "p95": 0, "max": 0, "count": 0 }
      },
      "errors": {
        "turnErrors": 0,      // turn 级别错误数
        "toolErrors": 0,      // tool/result.isError=true 的次数
        "turnErrorRate": 0    // turnErrors / turns（turns=0 时为 0）
      }
    }
  }
}
```

`latencyMs` 中的百分位数在每次 flush 时从截至当前的全部完成样本重算。
`tool` 分桶统计所有工具的整体时延；若需按工具名细分，可在 `toolCalls` 处扩展，
但基础契约不要求。

### 样例

```json
{
  "runId": "2026-01-01T00-00-00-000Z",
  "wallStart": 1751234567890,
  "wallEnd": 1751234572345,
  "sessions": {
    "session-a1b2c3d4": {
      "tokens": { "input": 8500, "output": 312, "total": 8812, "cacheRead": 0, "cacheWrite": 0, "reasoning": 0 },
      "counts": { "turns": 2, "steps": 3, "toolCalls": { "read_file": 2, "bash": 1 } },
      "latencyMs": {
        "turn":  { "p50": 1820, "p95": 2940, "max": 2940, "count": 2 },
        "step":  { "p50": 1500, "p95": 2800, "max": 2800, "count": 3 },
        "tool":  { "p50": 120,  "p95": 340,  "max": 340,  "count": 3 }
      },
      "errors": { "turnErrors": 0, "toolErrors": 0, "turnErrorRate": 0 }
    }
  }
}
```

---

## 派生关系与容错

Traces 和 Metrics 均是 Logs 的**纯函数派生物**：给定相同的 `logs.ndjson`，
可以无损重算出等价的 `trace.json` 和 `metrics.json`。
因此写盘失败优先保证 Logs，Traces/Metrics 可在下次 flush 时补偿。

三产物统一以 `runId` 为目录组织（如 `<output_dir>/<runId>/`），方便按运行隔离查看。
