# 生产级意图识别

为生产级 AI Agent 设计并实现意图识别(意图分类 + 槽位补全 + 拒识/澄清出口)。

本技能帮助工程师把用户的自由文本输入稳定地映射到一个有界意图集上,同时诚实地处
理「信息不足」「超范围」「元问题」三类无法正常分类的情况——不是靠硬猜,而是靠三
个明确出口和一套可评估的确定性内核。

## 它做什么

- 规定了一套以五条核心准则为脊椎的意图识别方法论:闭集有界 / 诚实出口 / 先规范化
  输入 / 确定性内核 / 可评估
- 定义了以 `intents.yml` 为中心的外化意图集 schema,含三个不可重定义的保留意图
  (`unclear` / `unsupported` / `meta`)
- 以一个真实 Agent 插件案例为参考,逐模块说明各项设计决策,并标注「刻意不做」
  的工程边界
- 设计了一条编号工作流(步骤 0-6),覆盖架构分层、意图集外化、闭集分类回收、判定
  优先级、槽位补全、软强制引导、离线评估,每步都回扣对应的核心准则
- 涵盖两类应用场景:开放域宿主(按需激活)与封闭域 agent(常开),以及六条生产级
  反模式及修复方案

## 何时使用

当 agent 需要以下任一能力时使用本技能:
- 把用户自由输入映射到有界意图集(闭集分类)
- 对超范围任务礼貌拒识,对元问题正常作答,对信息不足澄清追问
- 按 spec 必填集补全槽位(ask_user 问人 / auto_fetch 自动取)
- 构建可量化的离线评估体系,支撑意图识别持续迭代
- 理解 dsh-intent 的设计决策和工程取舍

触发词包括:"意图识别"、"意图分类"、"intent recognition"、"intent classification"、
"slot filling"、"槽位补全"、"拒识"、"澄清"、"closed-set classification"、"NLU"、
"对话理解"。

## 安装

1. 下载技能文件夹(或克隆本仓库)。
2. 在 Claude.ai 中进入 **Settings → Skills** 并上传文件夹。
3. 该技能会出现在你的可用技能列表中。

## 文件结构

```text
production-agent-intent/
├── SKILL.md                         # 主技能说明(本技能的完整方法论)
├── README.md                        # 本文件
└── references/
    ├── real-world-case.md           # dsh-intent 各模块落地印证(逐模块解剖)
    ├── intent-spec-schema.md        # intents.yml 完整 schema 契约
    ├── classification-contract.ts   # 参考类型:ClassificationResult / Outcome / EvalDecision
    └── offline-eval.md              # 离线评估:三指标定义 + 采集 runner 模式
```

## references/ 导览

- **real-world-case.md**:一个 Agent 意图识别插件的模块化案例。`glossary.ts`/`detect.ts`(输入
  规范化)、`intents.ts`(spec 解析校验)、`inject.ts`(注入 + report_intent 引导)、
  `classify.ts`(判定内核)、`index.ts`(接线激活)、`score.ts`(离线评估)逐模块解剖,
  每节回扣对应核心准则并标注「刻意不做」的边界。

- **intent-spec-schema.md**:`intents.yml` 的完整字段契约,包括 `version`(整数 1)、
  顶层 `slots` 数组(`globalRequired` 标全局必填)、`intents[].desc`/`.boundary`、
  `intents[].slots[].source`(`ask_user`/`auto_fetch`)、`intents[].fewshot`、保留意
  图约束等。

- **classification-contract.ts**:TypeScript 参考类型定义——`ClassificationResult`、
  `Outcome`、`EvalDecision`、`IntentSpec`——以及带注释的 `evaluateClassification` 完
  整实现,含 meta 短路分支、缺槽重算、confidence 阈值逻辑。

- **offline-eval.md**:Top-1 准确率、拒识准确率、槽位完整率三指标的定义与计算方式,
  采集 runner 模式(headless 批跑 → tap `tools/result`),以及「单轮测用例无法覆盖多
  轮补全」的诚实局限与应对策略。
