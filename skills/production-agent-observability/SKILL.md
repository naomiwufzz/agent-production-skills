---
name: production-agent-observability
description: 为框架无关的个人 Agent 装一套三支柱可观测性(Logs/Traces/Metrics):复用宿主已有事件流做采集,热路径非阻塞,本地落三产物(NDJSON 日志 / Chrome Trace 追踪 / 聚合指标 JSON),零外部后端、可离线查看。用户要给 agent 加可观测性/埋点/trace/日志/指标,或想看 agent 每轮花了多少 token、调了哪些工具、哪步慢、哪里报错,或可视化执行轨迹时使用。触发词:可观测性, 埋点, trace, 追踪, 指标, metrics, observability, tracing, agent telemetry, perfetto。
license: "Skill implementation guide for personal/educational use."
---

# production-agent-observability

为个人 Agent 提供框架无关的三支柱可观测性工作流。采集器挂在宿主已有的权威事件流上，流式写本地产物（Logs/Traces/Metrics），零外部后端，任何现成工具或自带查看器均可离线可视化。

## 核心原理

Agent 每步执行都会产生事件——工具调用、模型响应、轮次开始/结束、错误等。这些事件已经在宿主的事件流中存在；可观测性的关键设计决策是：**复用宿主已有的权威事件流做 backend，不平行 hook**（如 dsh-observe 做成 telemetry backend 复用其 capture 引擎，而非平行 hook 事件，这是同一原理的一个具体实现）。复用而非平行，既避免事件错序，也不引入额外的采集开销。

数据流如下：

```text
agent 每步事件 ─► 采集器(挂宿主事件流)
                   ├─ 流式写 logs.ndjson       (Logs,权威、完整)
                   └─ 精简事件入内存 buffer
轮末检查点 ─► flush:纯函数投影 buffer ─► trace.json / metrics.json
进程退出   ─► shutdown:最后一次投影 + 关闭日志流
```

## 默认原则

- **复用优先**：接宿主现成事件流 / capture seam，不平行造第二套采集。
- **热路径非阻塞**：采集在 agent 主循环同步路径上，只能入队/缓冲，禁止同步 IO 或 await（此规则作用于 emit 路径；flush 在轮末检查点运行，不在每次 emit 触发）。
- **纯函数投影**：Traces/Metrics 是对事件缓冲的零副作用纯函数，唯一副作用在写文件那一层。
- **本地自包含**：落本地文件，零外部后端；导出用通用格式（NDJSON / Chrome Trace / JSON），不锁厂商。
- **可离线查看**：产物能被现成工具（Perfetto）或自带查看器直接打开，无需联网。
- **观测不打扰**：采集/写盘失败静默降级，绝不让可观测性本身中断被观测的 agent。

## 三支柱

### Logs

每条事件对应日志中的一行结构化记录，格式为 NDJSON（每行一个独立 JSON 对象）。采集器在 emit 时流式追加写入 `logs.ndjson`，进程意外终止时保留到最后一次成功写的内容——这是三支柱里唯一的权威原始数据，Traces 和 Metrics 均从中派生。字段包含 `channel`、`time`、`severity`、`body` 以及携带 `session.id`、`event.type`、`event.seq` 等的 `attributes` 对象。

完整字段契约和 severity 映射见 [references/three-pillar-contract.md](references/three-pillar-contract.md)。

### Traces

turn → step → tool 的嵌套 span，导出为 Chrome Trace Event Format，可直接在 Perfetto 或 `chrome://tracing` 打开。规范约定：`pid=session`，`tid=turn`；每个 span 用 B（Begin）和 E（End）事件配对；**tool span 按 callId 配对而非 FIFO**——并行工具可能乱序完成，若按 FIFO 匹配，B/E 时长会错配到错误的工具调用上，callId 配对是唯一正确做法。未闭合的 span（进程被强杀时）在 `maxTs` 处补 E 事件。

完整字段定义和 B/E 映射表见 [references/three-pillar-contract.md](references/three-pillar-contract.md)。

### Metrics

按 session 分桶的聚合统计，落为单个 `metrics.json`。覆盖 token 用量（input/output/total/cacheRead/cacheWrite/reasoning）、turn/step/tool 计数、时延分布（p50/p95/max）、错误率（turnErrors/toolErrors/turnErrorRate）。Metrics 是纯函数派生物，可从 Logs 重算，因此写盘失败无需报错给 agent loop。

完整 schema 见 [references/three-pillar-contract.md](references/three-pillar-contract.md)。

## 采集生命周期

`emit` 在每个事件触发时同步入队（禁止阻塞主循环）；`flush` 在每轮结束时触发轮末检查点，全量重写 `trace.json` 和 `metrics.json`（常驻服务器无需等进程退出即可查看产物）；`shutdown` 在宿主 dispose 时被 await，执行最后一次投影并关闭日志流。flush 使用 coalesce 策略——写操作进行中时若有新脏数据，等本次写完再触发下一次，避免并发写坏文件。

生命周期各阶段的契约、callId 配对算法以及多 session 处理规则见 [references/capture-lifecycle.md](references/capture-lifecycle.md)。

## 安全与可靠性

- 事件正文可能含敏感数据（密钥、命令输出、用户输入）；**导出前脱敏由部署方负责**，采集侧不改写权威事件，改写会破坏从 Logs 重算其余产物的可能性。
- 写盘 best-effort，失败不抛给 agent loop；flush coalesce 确保同一时刻只有一次在写，写完若仍 dirty 再调度下一次写。
- Traces/Metrics 是 Logs 的纯函数派生物，任一时刻丢失均可从 `logs.ndjson` 重算，无需持久化中间 buffer。

## 怎么看

查看方式见 [references/viewer-guide.md](references/viewer-guide.md)：Perfetto 打开 `trace.json` 看 Traces 时间线、dashboard.html 拖入目录看三合一面板、jq 命令行过滤 Logs。

## 常见反模式

- 平行造第二套 hook，而不复用宿主权威事件流——导致事件重复、乱序，且维护两套采集路径。
- 在 emit 里同步 IO 或 await——阻塞 agent 主循环，让可观测性本身成为性能瓶颈。
- 把写盘副作用混进本应纯函数的投影里——使 Traces/Metrics 的可测性和可重算性变差。
- tool span 用 FIFO 配对——并行工具乱序完成时时长错配到错误调用，排查数据失真。
- 只在 shutdown 写产物——常驻服务器（不重启的 agent 进程）看不到任何 trace/metrics，仅能靠 logs。
- 为"完整"引入远程后端 / 向量库 / OTLP 上传作为默认——违背本地自包含原则，增加部署依赖，离线场景失效。
