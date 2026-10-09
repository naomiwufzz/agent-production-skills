# 查看指南

三支柱产物（`logs.ndjson` / `trace.json` / `metrics.json`）均为通用格式，
无需专有工具即可查看。本文介绍三种主要方式。

字段名约定见 [three-pillar-contract.md](three-pillar-contract.md)。

---

## 1. Perfetto — 查看 Traces

**适用**：可视化 `trace.json`，观察 turn→step→tool 的嵌套时间线。

**打开方式**

1. 在线版：访问 <https://ui.perfetto.dev>，点击 **Open trace file**，选择 `trace.json`。
2. 离线版：在 Chrome / Edge 地址栏输入 `chrome://tracing`（仅 Chrome / Chromium / Edge 支持；Perfetto 在线版支持所有浏览器），点击 **Load**，选择同一文件。

两种方式均可完全离线使用，数据不离开本机。

**读图要点**

- 泳道按 `pid=session / tid=turn` 分层：最外层是 session，往内是每个 turn，再往内是 step 和 tool。
- 每个 span 均有 `B`（开始）/ `E`（结束）事件对，时间单位为微秒（`ts` 字段）。
- tool span 按 `callId` 配对，并行工具不会错位——详见
  [capture-lifecycle.md § callId 配对](capture-lifecycle.md)。
- 若某 span 未正常闭合（进程崩溃），会在最大时间戳处补一个 `E` 事件，时间线仍可读。

**常用操作**：W/S 缩放、A/D 平移；点击 span 查看 `args`（含 token 用量、工具名等）。

---

## 2. dashboard.html — 三合一查看器

**适用**：在同一界面同时看 Metrics / Trace / Logs 三面板，无需起服务器。

**位置**：[../assets/dashboard.html](../assets/dashboard.html)

**打开步骤**

1. 用浏览器以 `file://` 协议直接打开 `dashboard.html`（双击或拖入地址栏均可）。
2. 把 `<outputDir>/<runId>/` 目录（或三个文件）拖入页面的拖放区。
3. 页面自动解析并渲染三个面板：

| 面板 | 数据源 | 内容 |
| --- | --- | --- |
| Metrics | `metrics.json` | token 用量、turn/step/tool 计数、时延 p50/p95/max、错误率 |
| Trace | `trace.json` | 与 Perfetto 同源的可缩放时间线 |
| Logs | `logs.ndjson` | 结构化日志，支持按 `severity` / `event.type` 过滤 |

**注意**：数据全程在本地浏览器内处理，不上传任何内容。

---

## 3. jq — 命令行过滤 Logs

**适用**：快速在终端过滤 `logs.ndjson`，无需图形界面。

**前提**：安装 [jq](https://jqlang.github.io/jq/)（多数系统包管理器可直接安装）。

**常用示例**

```bash
# 只看错误
jq -c 'select(.severity=="error")' logs.ndjson

# 只看工具调用事件，打印 body
jq -c 'select(.attributes["event.type"]=="tool/call") | .body' logs.ndjson

# 按 session 过滤（替换 <id> 为实际 session.id）
jq -c 'select(.attributes["session.id"]=="<id>")' logs.ndjson

# 统计每种 event.type 出现次数
jq -r '.attributes["event.type"]' logs.ndjson | sort | uniq -c | sort -rn

# 只看失败的工具结果（工具失败在 tool/result 记录上以 severity=="error" 表示）
jq -c 'select(.attributes["event.type"]=="tool/result" and .severity=="error")' logs.ndjson
```

字段路径（`severity`、`attributes["event.type"]`、`attributes["session.id"]` 等）
的完整定义见 [three-pillar-contract.md § Logs record](three-pillar-contract.md)。

---

## 快速选择

| 需求 | 推荐方式 |
| --- | --- |
| 可视化 turn/tool 时间线 | Perfetto |
| 一站式看全部三支柱 | dashboard.html |
| 脚本/CI 提取特定事件 | jq |
