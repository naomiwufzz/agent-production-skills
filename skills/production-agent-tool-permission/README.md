# 工具权限系统

为 agent 工具设计并实现分层、可配置的权限/安全系统。

本技能帮助工程师构建在每次工具调用前运行的权限流水线:一个统一决定「自动放行、询问用户、还是拒绝」的地方。流水线是分层的,企业管理员、用户、项目团队、单次会话都能各自贡献规则,高层级覆盖低层级,并可通过 hook 系统扩展。

## 它做什么

- 规定了一条每次工具调用都会经过的统一权限流水线(deny → ask → 工具自检 → 安全检查 → bypass → allow → 默认询问)
- 定义了带明确覆盖顺序的分层规则来源(`policySettings → userSettings → projectSettings → localSettings → cliArg → command → session`)
- 定义了 fail-closed(失败关闭)的工具安全接口(`isReadOnly` / `isDestructive` / `isConcurrencySafe` / `checkPermissions`),未声明的属性默认取最保守假设,外加免疫 bypass 模式的 `safetyCheck` 机制
- 涵盖 hook 系统的配置格式与生命周期,以及供无人值守运行使用的 AI 分类器 denial 追踪 circuit breaker
- 给出「完整参考模型 → MVP 落地裁剪」的取舍路径,并用真实案例覆盖两类应用场景:命令级权限(管 agent 自带工具)与业务功能级权限(按身份授权自研业务工具)

## 何时使用

当构建的 agent 需要控制哪些工具调用自动放行、哪些需要用户确认、哪些直接拒绝时使用本技能——尤其是系统必须在多个作用域(项目 / 用户 / 企业)可配置、并可通过 hook 扩展的场景。

触发词包括:"权限系统"、"工具安全"、"tool permission"、"permission system"、"tool safety"、"allow/deny rules"、"hook system"、"构建安全机制"。

## 安装

1. 下载技能文件夹(或克隆本仓库)。
2. 在 Claude.ai 中进入 **Settings → Skills** 并上传文件夹。
3. 该技能会出现在你的可用技能列表中。

## 文件结构

```text
production-agent-tool-permission/
├── SKILL.md                         # 主技能说明
├── README.md                        # 本文件
├── agents/
│   └── openai.yaml                  # OpenAI/Codex 风格 agent 的展示元数据
└── references/
    ├── real-world-case.md           # 真实落地案例(理论→代码,含命令级+业务级两类场景)
    ├── permission-pipeline.md       # 带注释的决策流水线实现
    ├── hook-system.md               # Hook 架构与事件类型
    └── settings-examples.json       # 完整 settings.json 配置示例
```
