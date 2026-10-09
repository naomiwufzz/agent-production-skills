# production-agent-observability

一个框架无关的个人 Agent 三支柱可观测性 Skill。它复用宿主已有的事件流作为唯一权威数据源，将每步事件投影为 Logs / Traces / Metrics 三份本地产物，零外部后端、可离线查看。

## 能力

- `Logs`：每条事件一行 NDJSON，流式写盘，崩溃仍保留到最后一次成功写。
- `Traces`：turn → step → tool 嵌套 span，导出 Chrome Trace Event Format，可在 Perfetto 或 `chrome://tracing` 可视化。
- `Metrics`：按 session 分桶的聚合统计——token 用量、turn/step/tool 计数、时延 p50/p95/max、错误率。
- `Dashboard`：自带离线三合一查看器（`assets/dashboard.html`），浏览器直接打开，拖入产物目录即渲染三面板。

## 适用场景

当需要给 Agent 加可观测性、埋点、trace、日志或指标时使用。也适用于查看每轮花了多少 token、调了哪些工具、哪步慢、哪里报错，或可视化 Agent 执行轨迹。

默认不上传远程后端，不依赖 OTLP 或向量库，不锁定特定厂商。

## 设计边界

- **框架无关**：讲普适原理与契约；任何 Agent 框架都能参照实现，不绑定具体框架。
- **本地自包含**：落本地文件，零外部后端；产物格式通用（NDJSON / Chrome Trace / JSON），便于人工审查、备份和迁移。
- **热路径非阻塞**：采集只入队/缓冲，禁止在 emit 路径同步 IO 或 await。
- **观测不打扰**：采集或写盘失败静默降级，绝不让可观测性本身中断被观测的 Agent。
- **脱敏由部署方负责**：事件正文可能含敏感数据，采集侧保留原始内容，导出前脱敏属部署职责。

## 安装

本 Skill 可随宿主插件分发，也可以作为独立 Skill 使用。若由插件加载,请遵循宿主项目自己的插件清单和安装约定。

### 独立使用

该 Skill 不依赖特定 Agent 框架。作为独立 Skill 使用时，将 `production-agent-observability/` 目录放入宿主的技能目录（入口文件为 `SKILL.md`），并确保 Agent 能够读写目标产物目录即可。

## 目录结构

```text
production-agent-observability/
├── SKILL.md
├── README.md
├── references/
│   ├── three-pillar-contract.md   # 三产物确切格式契约(NDJSON / Chrome Trace / 聚合 JSON)
│   ├── capture-lifecycle.md       # 采集生命周期:emit / flush / shutdown / callId 配对 / 多 session
│   └── viewer-guide.md            # 怎么看:Perfetto + dashboard + jq
└── assets/
    └── dashboard.html             # 离线三合一查看器
```

## 查看

参见 [references/viewer-guide.md](references/viewer-guide.md) 了解 Perfetto 和 jq 查看方式；浏览器直接打开 [assets/dashboard.html](assets/dashboard.html) 拖入产物目录即可渲染 Metrics / Trace / Logs 三面板。
