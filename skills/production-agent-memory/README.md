# production-agent-memory

一个框架无关的个人 Agent 记忆管理 Skill。它以本地 Markdown 为唯一规范源，帮助 Agent 安全地记住、召回、更新、删除和治理个人偏好与项目上下文。

## 能力

- `remember`：从明确的长期记忆意图中提取最小事实，检查敏感信息、重复和冲突后保存。
- `recall`：按作用域和相关性按需读取，控制上下文预算并附带来源。
- `update`：用稳定 `id` 和版本检查更新，不静默覆盖并存冲突。
- `forget`：删除正文、索引和派生缓存，报告部分失败范围。
- `audit`：检查索引大小、frontmatter、断链、越界指针、孤儿文件和过期内容。

## 适用场景

当用户要求“记住”“以后遵循”“回忆之前的偏好”“忘掉这条信息”或需要整理 `MEMORY.md` 时使用。它也适用于个人 Agent 在多次会话间保留稳定偏好、已确认反馈、项目决策和外部参考位置。

默认不自动保存用户随口表达的内容，也不把每次对话摘要当作长期记忆。

## 设计边界

- Markdown 是唯一规范源，方便人工审查、备份和迁移。
- 默认项目作用域隔离；个人作用域必须明确允许。
- 关键词扫描是默认检索方式，不要求数据库、向量索引或远程服务。
- 可以增加本地可重建的派生索引，但不能依赖它作为唯一数据源。
- 密码、Token、Cookie、私钥、支付信息和高敏感个人数据默认拒绝保存。
- 不保存源码可推导信息、Git 历史、临时任务、一次性调试步骤或未确认推断。

## 安装

### 手动安装

将技能目录放入个人技能目录或项目的 `.cursor/skills/` 目录，并确保入口文件为 `SKILL.md`。该 Skill 不依赖特定 Agent 框架；宿主只需让 Agent 能够读写目标记忆目录。

## 推荐目录

```text
memory/
├── MEMORY.md
├── user-background.md
├── feedback-testing.md
└── ...
```

`MEMORY.md` 只保留指向主题文件的相对链接。字段、操作输入输出、冲突和删除语义见 [references/memory-operation-contract.md](references/memory-operation-contract.md)；四类记忆的边界见 [references/memory-type-definitions.md](references/memory-type-definitions.md)。

## 审计

审计脚本只读扫描，不会修改或删除记忆：

```bash
python3 scripts/memory_audit.py <memory-dir>
```

明确传入记忆目录可避免宿主自动发现路径错误。脚本使用 200 行、25,000 bytes 和 200 个主题文件作为默认治理阈值；这些是可配置的默认约束，不代表所有 Agent 的加载限制。

## 测试

当前项目没有运行时依赖。使用已安装的 TypeScript 编译器编译契约测试，再由 Node 执行：

```bash
rm -rf /tmp/production-agent-memory-tests
tsc tests/memory-audit.test.ts --target ES2020 --module commonjs --outDir /tmp/production-agent-memory-tests
node /tmp/production-agent-memory-tests/memory-audit.test.js
```

测试会创建临时记忆目录，验证健康索引、越界指针和未索引主题文件；不会读取或修改真实个人记忆。

## 目录结构

```text
production-agent-memory/
├── SKILL.md
├── README.md
├── references/
│   ├── memory-operation-contract.md
│   └── memory-type-definitions.md
├── scripts/
│   └── memory_audit.py
└── tests/
    └── memory-audit.test.ts
```
