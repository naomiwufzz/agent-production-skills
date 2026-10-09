---
name: production-agent-tool-permission
description: '为 agent 工具设计并实现分层、可配置的权限/安全系统。当构建的 agent 需要控制哪些工具调用自动放行、哪些需要用户确认、哪些直接拒绝时使用本技能——尤其是系统必须在多个作用域(项目/用户/企业)可配置、并可通过 hook 扩展的场景。触发词: "权限系统", "工具安全", "tool permission", "permission system", "tool safety", "allow/deny rules", "hook system", "构建安全机制".'
---

# 工具权限系统

## 核心思路

每次 agent 调用工具前,都会先跑一条**权限流水线**。这条流水线是唯一决定「自动放行、询问用户、还是拒绝」的地方。流水线是分层的——不同角色(企业管理员、用户、项目团队、会话)都能贡献规则,高层级覆盖低层级。

```
工具调用请求
  ↓
[硬否决] Deny 规则 → 立即拒绝
  ↓
[强制确认] Ask 规则 → 强制弹框(即使 bypass 模式)
  ↓
[工具自身] 工具的 checkPermissions() → 工具专属逻辑
  ↓
[安全绕过免疫] 安全检查(.git/、.claude/、shell 配置)→ 弹框,免疫 bypass
  ↓
[模式快速通过] Bypass / acceptEdits 模式 → 立即放行
  ↓
[白名单] Allow 规则 → 立即放行
  ↓
[默认] passthrough → 询问用户(ask)
```

**外层包装**（作用于整条流水线之后）：
- `dontAsk` 模式：把所有 `ask` 转为 `deny`（用于无交互的后台 agent）
- `auto` 模式：把所有 `ask` 转给 AI 分类器判断，而不是打断用户
- `headless` 模式：先跑 PermissionRequest hooks，hooks 没回应就自动 deny

### 参考模型 vs 落地裁剪

上面这条 7 步流水线是一个完整的参考模型。真实落地时几乎不会一次实现全部,而是按 YAGNI 裁到一个核心子集。

一个可用的 MVP 只需要**核心 5 步**:

```
deny → ask → safety → allow → default(passthrough / ask / deny)
```

常见的裁剪(可留待后续 phase,或宿主已提供时直接复用):

| 完整模型的层 | MVP 是否需要 | 裁剪理由 |
|---|---|---|
| deny / ask / allow 规则 | ✅ 必须 | 权限系统的本体 |
| safety 硬编码黑名单 | ✅ 必须 | 安全底线,成本极低 |
| 分层规则来源 | ✅ 必须 | 复用宿主的配置分层即可 |
| AI 分类器 + denial 追踪 circuit breaker | ❌ 可砍 | `auto` 模式是实验性的;`ask` 直接交人工审批更简单可靠 |
| Hook 系统 | ⚠️ 看宿主 | 宿主已有 hooks 就别重复造 |
| 规则改写 `args` | ❌ 建议不做 | 日志/呈现会与实际运行失同步,得不偿失 |
| UI 规则编辑器 | ❌ 可砍 | 规则走配置文件手编即可 |

**判断标准**:先问「这个 agent 是交互式还是无人值守?」交互式场景下,宿主原生的 ask/审批 + sandbox 往往已够用,权限系统的增量价值主要是**细粒度规则 + safety 黑名单**;无人值守场景(CI、批处理、长自主循环)才真正需要「git 自动过、rm 直接拒、curl 弹确认」这种细粒度自动裁决。

真实落地代码见 `references/real-world-case.md`。

## 工作流

### 0. 架构:纯函数内核 + 薄集成壳

动手写代码前先定架构。权限系统天然分成两类代码:**决策逻辑**(给定规则和输入,判定 allow/deny/ask)和**宿主接合**(读配置、挂工具执行钩子、弹审批框)。把它们分层:

```
宿主(host):工具执行钩子 / 配置分层解析 / 审批 UI
      │ apply(ctx, config)
┌─────▼──────────────────────────────────┐
│ 集成壳(唯一碰 host)                     │
│  · 注册配置 namespace                    │
│  · 挂 pre-execute 钩子                   │
│  · 取规则 → 调 decide() → 返回决策        │
│  · 读配置失败 → 降级 + warn             │
└──┬────────────┬───────────────┬─────────┘
┌──▼──────┐ ┌───▼────────┐ ┌────▼───────┐
│ decide  │ │ match      │ │ safety     │
│ 决策流水 │ │ 规则匹配    │ │ 危险黑名单  │
│ (纯函数) │ │ (纯函数)    │ │ (纯函数)   │
└─────────┘ └────────────┘ └────────────┘
```

- **内核(match / decide / safety)零 I/O、零 host 依赖**:输入是普通数据(规则数组、工具名、参数),输出是决策对象。可以完全脱离 agent 框架单测,`decide(rules, toolName, args, opts)` 一行断言一个场景。
- **脏活全部上浮到集成壳**:碰 host API、读配置、弹审批的代码集中在一个入口函数里。
- **收益**:决策逻辑(最需要正确性的部分)能做到 100% 单测覆盖;换宿主/换框架时只重写薄薄的集成壳,内核原样搬走。

这是本 skill 反复出现的模式——下面每一步的规则匹配、决策流水线、安全检查,都属于「纯函数内核」;只有最后接入 agent 时才需要集成壳。

### 1. 定义三种决策行为

```typescript
type PermissionBehavior = 'allow' | 'deny' | 'ask'

type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown; decisionReason?: DecisionReason }
  | { behavior: 'ask';   message: string; suggestions?: PermissionUpdate[] }
  | { behavior: 'deny';  message: string; decisionReason: DecisionReason }
```

### 2. 建立分层规则来源

规则来源按优先级从高到低排列：

```
policySettings    ← 企业管理员，用户不可覆盖
userSettings      ← 用户全局 (~/.agent/settings.json)
projectSettings   ← 项目级 (.agent/settings.json，可提交 git)
localSettings     ← 本地私有 (.agent/settings.local.json)
cliArg            ← 启动参数
command           ← 运行时命令
session           ← 当次会话临时
```

每条规则的格式：`ToolName` 或 `ToolName(content)`。

各层同名规则数组做 **union**(合并),不是覆盖。裁决时靠决策顺序保证优先级——deny 在 allow 之前判,所以企业 policy 层的 deny 恒胜,不会被下层用户的 allow 翻案(见第 3 步)。

**规则匹配的工程细节**(纯函数,给定 `(规则字符串, 工具名, 参数)` → boolean):

1. **工具名匹配**:先解析 `ToolName(content)`(一个正则即可:`/^([a-z_][\w-]*)(?:\(([^)]*)\))?$/i`)。无 `content` 时只比工具名,命中即匹配整个工具。
2. **主内容字段表**:不同工具的「可匹配内容」在不同参数字段里。维护一张登记表:

   ```typescript
   // 工具名 → { 主内容字段, matcher }
   const CONTENT_FIELDS = {
     bash:  { field: 'command',   matcher: 'prefix' },  // 命令前缀
     pwsh:  { field: 'command',   matcher: 'prefix' },
     read:  { field: 'path',      matcher: 'glob'   },  // 路径 glob
     edit:  { field: 'path',      matcher: 'glob'   },
     write: { field: 'file_path', matcher: 'glob'   },
   }
   ```

   **未登记的工具只支持工具名级规则**——带 `content` 的规则对它一律不命中(fail-closed:宁可不匹配,不瞎猜字段)。
3. **两种 matcher**:
   - **前缀**(命令):`bash(git:*)` 命中 `git` 或 `git ` 开头的命令。
   - **glob**(路径):`edit(/etc/**)` 把 `*` 转 `[^/]*`、`**` 转 `.*` 后正则匹配。
4. **shell 家族别名**(跨平台必备):把 `bash`/`pwsh`/`sh` 视为同一族,族内工具名互通。这样 `bash(rm:*)` 在 Linux 匹配 `bash`、在 Windows 也能拦住 `pwsh` 的 `rm`——规则可移植,不因平台工具名差异而**静默失效**(静默失效是安全系统最危险的失败模式)。

### 3. 实现权限决策函数

```typescript
async function hasPermission(tool, input, context): Promise<PermissionDecision> {
  // Step 1: deny rules (优先级最高，含企业强制)
  const denyRule = findMatchingRule(context.denyRules, tool, input)
  if (denyRule) return { behavior: 'deny', message: '...', decisionReason: { type: 'rule', rule: denyRule } }

  // Step 2: ask rules (强制弹框，绕过模式也无法跳过)
  const askRule = findMatchingRule(context.askRules, tool, input)
  if (askRule) return { behavior: 'ask', message: '...' }

  // Step 3: 工具自身的 checkPermissions()
  const toolResult = await tool.checkPermissions(input, context)
  if (toolResult.behavior === 'deny') return toolResult
  if (toolResult.behavior === 'ask' && toolResult.decisionReason?.type === 'rule') return toolResult  // ask rule 免疫 bypass
  if (toolResult.behavior === 'ask' && toolResult.decisionReason?.type === 'safetyCheck') return toolResult  // 安全检查免疫 bypass

  // Step 4: bypass 模式快速通过
  if (context.mode === 'bypassPermissions') return { behavior: 'allow', updatedInput: input }

  // Step 5: allow rules 白名单
  const allowRule = findMatchingRule(context.allowRules, tool, input)
  if (allowRule) return { behavior: 'allow', updatedInput: input }

  // Step 6: 默认转 ask
  return { behavior: 'ask', message: `Agent 请求使用 ${tool.name}` }
}
```

### 4. 为每个工具定义安全属性接口（fail-closed 默认值）

工具与权限系统的接合点是工具接口上的一组**安全属性**。关键设计：所有属性都遵循**失败关闭（fail-closed）**——开发者不声明时，系统按"最保守"假设处理，必须主动声明"我是安全的"才放宽。

```typescript
// 工厂函数用 TOOL_DEFAULTS 填充未声明的属性
const TOOL_DEFAULTS = {
  isEnabled:         () => true,
  isConcurrencySafe: () => false,   // 默认不并发（怕数据竞争）
  isReadOnly:        () => false,   // 默认假设会写入
  isDestructive:     () => false,   // 默认假设不可逆操作要谨慎
  checkPermissions:  (input) => ({ behavior: 'allow', updatedInput: input }), // 默认交给中央权限系统
}
function buildTool(def) { return { ...TOOL_DEFAULTS, ...def } }
```

| 属性 | 返回 | 谁来问 / 影响什么 |
|---|---|---|
| `isReadOnly(input)` | boolean | 权限系统：只读操作可绕过部分限制 |
| `isDestructive(input)` | boolean | 权限系统：不可逆操作需更严格确认 |
| `isConcurrencySafe(input)` | boolean | Agent Loop：能否与其他工具并发执行（默认 false → 串行） |
| `checkPermissions(input, ctx)` | PermissionResult | 权限系统：工具专属权限逻辑（流水线 1c） |
| `validateInput(input, ctx)` | ValidationResult | Agent Loop：执行前的输入合法性校验 |

**`checkPermissions` 在流水线里的位置是"夹心结构"**：通用 deny/ask 规则在它**之前**（且 bypass 也拦不住），通用 allow 白名单在它**之后**。所以工具自检既挡不住企业 deny，也不必重复实现通用 allow——只管工具特有的逻辑：

```typescript
class MyTool implements Tool {
  isReadOnly = () => false
  isConcurrencySafe = () => false

  async checkPermissions(input, context): Promise<PermissionResult> {
    // 检查工具特定规则（如 Bash 检查具体命令前缀）
    const allowRules = getRuleContentsForTool(context, this, 'allow')
    if (allowRules.has(getCommandPrefix(input.command))) {
      return { behavior: 'allow' }
    }

    // 检查危险路径（命中后 type:'safetyCheck' → bypass 也拦不住，见下方说明）
    if (isDangerousPath(input.path)) {
      return {
        behavior: 'ask',
        message: '...',
        decisionReason: { type: 'safetyCheck', reason: '...', classifierApprovable: false }
      }
    }

    return { behavior: 'passthrough', message: '...' }  // 没意见 → 交给外层
  }
}
```

**危险路径黑名单**（`safetyCheck`）是一份硬编码的敏感文件/目录清单，即使 bypass / acceptEdits / 配了 allow 规则也强制弹框，防两类攻击：① 代码执行（`.git/` hooks、`.bashrc`/`.zshrc` 等 shell 启动脚本、`.vscode`/`.idea` 任务配置）；② AI 改自己的护栏（`.claude/`、`.mcp.json`、`.claude.json` —— agent 不能通过"正常编辑文件"给自己提权）。清单应由项目根据自身威胁模型独立维护。

### 4.5 fail-closed 是有分层的

「失败关闭」不是「所有失败都拒绝」这么粗暴——真实系统里它分两层,取舍不同:

- **安全底线(硬编码黑名单)→ 不可降级**:无论配置怎么坏、规则怎么读不到,safety 检查永远运行。它是一份不依赖任何外部输入的硬编码常量,没有「读取失败」的可能,所以必须永在。
- **可配规则层 → 允许降级**:读分层配置失败(文件损坏、namespace 未注册)时,不该锁死整个 agent,而是**降级到 `defaultBehavior` + 打 warn 日志**,让 agent 带着「空规则 + safety 仍生效」继续跑。

这是「fail-closed 原则」与「配置故障不该锁死会话」之间的显式取舍:**安全底线宁可误伤不可漏放,便利性配置层宁可降级不可阻断**。区分这两层,系统才既安全又不脆弱。

授权本身仍严格 fail-closed:拉不到权限、无审批应答者、规则损坏到无法判定时,一律当 deny,绝不「拿不准就放行」。

### 5. 实现 Hook 系统（可选但推荐）

Hook 让用户/企业在工具生命周期各节点插入自定义逻辑：

```typescript
// 配置格式（settings.json）
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "MyTool",          // 可选，工具名过滤
      "hooks": [{
        "type": "command",          // command | prompt | agent | http
        "command": "check-safety.sh $TOOL_INPUT"
      }]
    }],
    "PostToolUse": [{
      "matcher": "FileEdit",
      "hooks": [{ "type": "command", "command": "prettier --write $FILE_PATH" }]
    }]
  }
}
```

Hook 执行结果影响权限决策：
- exit 0 → 通过
- exit 2 → block（工具不执行）
- stdout 包含 JSON `{"action": "allow"}` → 覆盖决策

### 6. 实现 Denial 追踪（AI 分类器场景）

当使用 AI 分类器自动判断权限时，需要 circuit breaker 防止分类器过于严格：

```typescript
// 连续拒绝 3 次或累计拒绝 20 次 → 回退到人工确认
const DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 }

function shouldFallback(state: DenialTrackingState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    state.totalDenials >= DENIAL_LIMITS.maxTotal
  )
}
```

## 必做的决策

设计时必须明确的四个问题：

1. **完整模型里,这次要实现哪个子集？** → 交互式先做核心 5 步;无人值守才值得加 AI 分类器等(见「参考模型 vs 落地裁剪」)
2. **哪些操作永远不需要确认？** → 放入 allow rules（如只读操作）
3. **哪些操作永远需要确认，不可绕过？** → 用 `decisionReason.type === 'safetyCheck'` 标记
4. **无人值守场景（CI/后台 agent）怎么处理？** → `shouldAvoidPermissionPrompts = true` + 跑 hooks + 自动 deny

## 最简模式

```typescript
// 最简实现：三层规则 + 工具自检
type Rule = { toolName: string; content?: string; behavior: 'allow' | 'deny' | 'ask' }

type PermissionContext = {
  mode: 'default' | 'bypassPermissions' | 'acceptEdits'
  allowRules: Rule[]
  denyRules: Rule[]
  askRules: Rule[]
}

async function checkPermission(toolName: string, input: unknown, ctx: PermissionContext) {
  if (ctx.denyRules.some(r => matches(r, toolName, input))) return 'deny'
  if (ctx.askRules.some(r => matches(r, toolName, input))) return 'ask'
  if (ctx.mode === 'bypassPermissions') return 'allow'
  if (ctx.allowRules.some(r => matches(r, toolName, input))) return 'allow'
  return 'ask'  // default: prompt
}
```

## 两类应用场景

同一套决策内核,**只换「规则来源」就能覆盖两类完全不同的权限需求**。这是这套架构最值得强调的复用点。

### 场景 A:命令级权限(管 agent 自带工具)

管的是 `bash` / `read` / `edit` 这类通用工具,规则针对**命令内容/文件路径**。规则读本地配置文件,纯离线、不依赖任何后端。

- 规则形态:`allow: [read, bash(git:*)]` / `deny: [bash(rm:*)]` / `ask: [bash(curl:*)]`
- 最高价值落点:**无人值守场景**(CI、批处理、长自主循环)。没人盯着时「git 自动过、rm 直接拒、curl 弹确认」才真正有意义。交互式使用下,宿主原生的 ask/审批 + sandbox 往往已够,增量主要在细粒度规则 + safety 黑名单。

### 场景 B:业务功能级权限(管自研业务工具)

管的是自研业务工具(查天气/订票/退款…),规则针对**调用者身份**——每个用户按身份拿到一份**授权工具白名单**,清单外的业务功能一律禁。面向多租户/多角色业务 agent。

- 规则来源可切换:`static`(身份→工具白名单写本地配置,离线)/ `api`(调后端权限服务,**超时/不可达一律 fail-closed 拒**)。
- 关键工程点:
  - **懒加载 + 缓存 + inflight 去重**——不依赖 session-start 时序(异步拉取可能晚于首次工具调用),改为首次业务工具调用时按需拉取,消除竞态。
  - **把授权清单注入模型上下文**——让模型知道自己能调哪些(减少无效调用),但这只是提示,**门禁裁决仍以 pre-execute 为权威**,不信任模型自觉。
  - **区分「无权限」与「拉取失败」**——未知身份 → 空集(确实无权限,`ok:true`);网络错/超时 → `ok:false`(fail-closed 拒)。

两类场景的决策流水线、fail-closed、纯函数内核**完全一致**,差异只在「规则从哪来、匹配什么」。真实代码见 `references/real-world-case.md`。

## 边界

本技能负责:
- 权限决策流水线的设计与实现
- 分层规则来源（policySettings → session）的优先级架构
- 工具级安全属性接口设计（`isReadOnly` / `isDestructive` / `isConcurrencySafe` / `checkPermissions` + fail-closed 默认值）
- Hook 系统的配置格式和生命周期事件
- AI 分类器 + Denial 追踪的 circuit breaker 模式
- 危险操作硬编码黑名单的设计原则

本技能不负责:
- 具体工具的业务逻辑（只关注权限接口）
- UI 确认弹框的实现（只关注决策结果）
- 用户认证/身份校验（不同于工具权限）
- AI 分类器的具体 prompt 工程

## 需要更多细节时

- **真实落地案例(理论→代码的桥,含两类场景完整实现)** → `references/real-world-case.md`
- 决策流水线带注释的详细实现 → `references/permission-pipeline.md`
- Hook 系统架构与所有事件类型 → `references/hook-system.md`
- settings.json 配置完整示例 → `references/settings-examples.json`
