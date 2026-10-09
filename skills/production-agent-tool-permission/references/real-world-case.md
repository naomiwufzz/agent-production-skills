# 真实落地案例:从完整模型裁到可用 MVP

> 本文提炼自一套在真实 agent 框架(DeepSeek Harness)上落地的权限门禁实现。
> 目的是把 SKILL.md 的理论模型「翻译」成可直接照抄的代码骨架,并展示真实项目做了哪些 YAGNI 取舍。
> 代码已去框架化——把宿主特定 API(工具执行钩子、审批系统、配置 schema)写成通用签名,不依赖任何具体框架。

---

## 案例一:命令级权限门禁

管 agent 自带工具(`bash` / `read` / `edit`…),规则针对命令内容/文件路径,纯离线读本地配置。

### 决策流水线(decide.ts —— 纯函数内核)

完整参考模型有 7 步,这个 MVP 只保留**核心 5 步**。注意顺序即安全策略:

```typescript
export interface RuleSet { allow: string[]; deny: string[]; ask: string[] }

export type Decision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }
  | { kind: 'passthrough' }   // 未命中任何规则,交回宿主默认门禁

export function decide(
  rules: RuleSet,
  toolName: string,
  args: unknown,
  opts: { enableSafetyChecks: boolean; defaultBehavior: 'passthrough' | 'ask' | 'deny' },
): Decision {
  // 1. deny 最高优先(企业层 deny 不可被下层 allow 翻案)
  if (rules.deny.some(r => matchRule(r, toolName, args)))
    return { kind: 'deny', reason: `工具 ${toolName} 命中 deny 规则` }

  // 2. ask 强制确认
  if (rules.ask.some(r => matchRule(r, toolName, args)))
    return { kind: 'ask', reason: `工具 ${toolName} 命中 ask 规则` }

  // 3. safety 硬编码黑名单(配了 allow 也拦不住)
  if (opts.enableSafetyChecks) {
    const danger = isDangerous(toolName, args)
    if (danger) return { kind: 'ask', reason: `安全检查: ${danger}` }
  }

  // 4. allow 白名单
  if (rules.allow.some(r => matchRule(r, toolName, args)))
    return { kind: 'allow' }

  // 5. 默认兜底(passthrough 交回宿主 / deny / ask)
  if (opts.defaultBehavior === 'passthrough') return { kind: 'passthrough' }
  if (opts.defaultBehavior === 'deny') return { kind: 'deny', reason: `默认拒绝 ${toolName}` }
  return { kind: 'ask', reason: `默认需确认 ${toolName}` }
}
```

**为什么这个顺序**:
- **deny 在 allow 前**:各配置层同名数组 union 后,只要任一层 deny 命中就拒,企业管理员的禁令无法被用户 allow 翻案。
- **safety 在 allow 前**:硬编码黑名单命中即强制 ask,即使用户显式配了 allow 也拦不住(见案例末 safety 节)。
- **passthrough vs deny**:`passthrough` 是「我没意见,交回宿主既有门禁」,避免对未列名工具双重弹框;`deny` 是「我明确拒绝」。这个区分让权限插件能和宿主原生审批层共存。

### 规则匹配(match.ts —— 纯函数内核)

```typescript
// 解析 "ToolName" 或 "ToolName(content)"
const RULE_RE = /^([a-z_][a-z0-9_-]*)(?:\(([^)]*)\))?$/i
function parseRule(rule: string): { tool: string; content?: string } | null {
  const m = RULE_RE.exec(rule.trim())
  return m ? { tool: m[1], content: m[2] } : null
}

// shell 家族:同族工具名互通,规则跨平台可移植
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'sh'])
function toolMatches(ruleTool: string, toolName: string): boolean {
  if (ruleTool === toolName) return true
  return SHELL_TOOLS.has(ruleTool) && SHELL_TOOLS.has(toolName)
}

// 每个工具的「主内容字段」+ 匹配方式;未登记工具只支持工具名级规则
const CONTENT_FIELDS: Record<string, { field: string; matcher: 'prefix' | 'glob' }> = {
  bash:  { field: 'command',   matcher: 'prefix' },
  pwsh:  { field: 'command',   matcher: 'prefix' },
  read:  { field: 'path',      matcher: 'glob'   },
  edit:  { field: 'path',      matcher: 'glob'   },
  write: { field: 'file_path', matcher: 'glob'   },
}

// 命令前缀:"git:*" 命中 "git" 或 "git " 开头
function matchPrefix(pattern: string, command: string): boolean {
  if (pattern.endsWith(':*')) {
    const p = pattern.slice(0, -2)
    return command === p || command.startsWith(p + ' ')
  }
  return command === pattern
}

// 路径 glob:* → [^/]* , ** → .*
function matchGlob(pattern: string, path: string): boolean {
  const re = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // 转义正则元字符
    .replace(/\*\*/g, ' ')                  // ** 临时占位
    .replace(/\*/g, '[^/]*')                // * 不跨目录
    .replace(/ /g, '.*') + '$'              // ** 还原为跨目录
  return new RegExp(re).test(path)
}

export function matchRule(rule: string, toolName: string, args: unknown): boolean {
  const parsed = parseRule(rule)
  if (!parsed || !toolMatches(parsed.tool, toolName)) return false
  if (parsed.content === undefined) return true          // 工具名级规则:命中整个工具
  const cf = CONTENT_FIELDS[toolName]
  if (!cf) return false                                  // 未登记工具 + 内容规则 → 不命中(fail-closed)
  const value = (args as Record<string, unknown> | null)?.[cf.field]
  if (typeof value !== 'string') return false
  return cf.matcher === 'prefix' ? matchPrefix(parsed.content, value) : matchGlob(parsed.content, value)
}
```

**三个真实环境才暴露的细节**(SKILL.md 理论模型没强调):
1. **CONTENT_FIELDS 登记表**——「同一个 content 该匹配 args 的哪个字段」因工具而异。登记表把这层映射显式化;未登记工具的内容规则一律不命中,而不是瞎猜字段。
2. **shell 家族别名**——不做这个,`bash(rm:*)` 规则在 Windows(工具名是 `pwsh`)会**静默失效**,用户以为拦住了实际没拦。静默失效是安全系统最危险的失败模式。
3. **前缀 vs glob 分开**——命令用前缀(`git:*` 匹配子命令),路径用 glob(`/etc/**` 匹配子目录),语义不能混用。

### 安全黑名单(safety.ts —— 纯函数内核)

硬编码危险模式,命中一律强制 ask,配了 allow 也拦不住。分**危险路径**和**破坏性命令**两类:

```typescript
const PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.git\/hooks\//,                                  // git hook 代码执行
  /(^|\/)\.(bashrc|zshrc|bash_profile|profile|zprofile)$/, // shell 启动脚本
  /(^|\/)\.(vscode|idea)\//,                               // 编辑器任务配置
  /(^|\/)\.claude(\/|$)/,                                  // agent 自我提权
  /(^|\/)\.claude\.json$/,
  /(^|\/)\.mcp\.json$/,
  /(^|\/)settings\.(json|ya?ml)$/,
]
const COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-\S*\s+)*-\S*[rf]/,        // rm -rf / rm -fr / rm -r -f
  /\bmkfs\b/,                         // 格式化文件系统
  /\bdd\b[^\n]*\bof=/,                // 覆写块设备
  /:\s*\(\s*\)\s*\{.*:\s*\|\s*:.*\}/, // fork bomb
]

export function isDangerous(toolName: string, args: unknown): string | null {
  const a = args as Record<string, unknown> | null
  const path = typeof a?.path === 'string' ? a.path
    : typeof a?.file_path === 'string' ? a.file_path : undefined
  if (path) for (const re of PATH_PATTERNS) if (re.test(path)) return `危险路径: ${path}`
  const command = typeof a?.command === 'string' ? a.command : undefined
  if (command) for (const re of COMMAND_PATTERNS) if (re.test(command)) return `危险命令: ${command}`
  return null
}
```

两类模式对应两类攻击:**路径类**堵代码执行(改 shell 启动脚本/git hook)和自我提权(改 `.claude/`/`.mcp.json` 等 agent 自己的护栏);**命令类**堵不可逆破坏(`rm -rf`/`mkfs`/`dd`/fork bomb)。这份清单是硬编码常量,不依赖任何外部输入,所以**永远运行、不可降级**。

### 集成壳(唯一碰宿主的地方)

内核是纯函数,接入 agent 时才需要这层。它做四件事:注册配置、挂工具执行钩子、调 `decide()`、读配置失败时降级。

```typescript
// 伪代码:apply(ctx, config) —— ctx 是宿主注入的能力
export function apply(ctx, config) {
  if (!config.enabled) return

  // 读分层配置(policy→user→project→local),拿到最新规则快照的 thunk
  let getRules = () => ({ allow: [], deny: [], ask: [] })
  try {
    ctx.installSettings('tool-permission', schema, (current) => { getRules = current })
  } catch (e) {
    ctx.logger?.warn?.(`settings 注册失败,降级空规则: ${e}`)  // ← 降级,不崩会话
  }

  // 挂工具执行前钩子:next() = 委托回宿主默认门禁
  ctx.on('tools/pre-execute', async (exec, next) => {
    const rules = getRules() ?? { allow: [], deny: [], ask: [] }
    const d = decide(rules, exec.name, exec.arguments, {
      enableSafetyChecks: config.enableSafetyChecks,
      defaultBehavior: config.defaultBehavior,
    })
    if (d.kind === 'passthrough') return next()          // 交回宿主
    if (d.kind === 'allow') return { kind: 'allow' }
    if (d.kind === 'deny')  return { kind: 'deny', reason: d.reason }
    return { kind: 'ask', reason: d.reason }             // 交宿主审批;无应答者时 fail-closed 成 deny
  })
}
```

### 三层降级(fail-closed 但不脆弱)

| 故障点 | 降级策略 |
|---|---|
| 读配置失败 | 视为空规则,降到 `defaultBehavior` + warn(safety 仍生效) |
| 规则字符串格式非法 | `parseRule` 返回 null,该条跳过,不影响其余规则 |
| 未知工具的内容规则 | 不命中(工具名级规则仍有效) |
| `enabled=false` | 钩子直接 `next()`,完全透明 |

原则:**安全底线(黑名单)不可降级;可配规则层的基建故障降级而非阻断整个 agent**。这正是 SKILL.md「fail-closed 是有分层的」那一节的落地。

### 案例一做的 YAGNI 取舍

砍掉了:AI 分类器 + denial 追踪 circuit breaker(`ask` 直接交人工审批)、Hook 系统(宿主已有 hooks 包)、规则改写 args(日志会与实际运行失同步)、UI 规则编辑器(规则走配置文件手编)。留下的就是上面这套「5 步决策 + 匹配 + 黑名单 + 集成壳」,四个文件、全部内核可单测。

---

## 案例二:业务功能级权限

同一套决策思路,**换规则来源**:不再匹配命令内容,而是按**调用者身份**拿一份授权工具白名单。面向多租户/多角色业务 agent(通用 agent 注册全量业务工具,每个用户按身份只拿到子集)。

### 权限来源(可切换 static / api)

```typescript
export interface PermissionResult {
  allowed: string[]
  ok: boolean          // false = 拉取失败(fail-closed:业务工具一律拒)
}

// static:读本地配置(离线);未知身份 → 空集(确实无权限,ok:true)
function fromStatic(rules: Record<string, string[]>, identity: string): PermissionResult {
  const raw = rules[identity]
  if (!raw) return { allowed: [], ok: true }   // 无权限 ≠ 失败
  return { allowed: sanitize(raw), ok: true }
}

// api:调后端,带超时;任何异常/非 200 → ok:false(fail-closed)
async function fromApi(endpoint: string, identity: string, timeoutMs = 3000): Promise<PermissionResult> {
  try {
    const res = await fetch(`${endpoint}?identity=${encodeURIComponent(identity)}`,
      { signal: AbortSignal.timeout(timeoutMs) })       // ← 外部调用必须有超时
    if (!res.ok) return { allowed: [], ok: false }
    const data = await res.json() as { allowed?: string[] }
    return { allowed: sanitize(data.allowed ?? []), ok: true }
  } catch {
    return { allowed: [], ok: false }                    // 超时/网络错/解析错 → fail-closed
  }
}
```

**关键区分:「无权限」vs「拉取失败」**。未知身份是「确实没被授权」(`ok:true`,空集),网络故障是「没拿到授权信息」(`ok:false`,fail-closed 拒)。混为一谈会让网络抖动被误当成「该用户无权限」,或更糟——把「拉取失败」当成「无限制」放行。

### 门禁 + 懒加载(index.ts 集成壳)

```typescript
export function apply(ctx, config) {
  for (const def of BIZ_TOOL_DEFS) ctx.tools.register(def)   // 注册全量业务工具

  // 缓存 + inflight 去重:不依赖 session-start 时序,首次业务工具调用时按需拉取
  let cached: string[] | null = null
  let cacheOk = true
  let inflight: Promise<void> | null = null
  const ensureLoaded = () => {
    if (cached !== null) return Promise.resolve()
    if (inflight) return inflight
    inflight = fetchAllowedTools(config.permissionSource, config.identity)
      .then(r => { cached = r.allowed; cacheOk = r.ok })
      .catch(() => { cached = []; cacheOk = false })         // fail-closed
      .finally(() => { inflight = null })
    return inflight
  }

  // 会话开始:best-effort 把授权清单注入模型上下文(让模型知边界,但非门禁权威)
  ctx.on('agent/session-start', async ({ agent }) => {
    await ensureLoaded()
    agent.inject(`你(身份 ${config.identity})被授权调用:${(cached ?? []).join('、') || '(无)'}。调用未授权工具会被拒。`)
  })

  // pre-execute 门禁:业务工具鉴权,非业务工具透传
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!isBizTool(exec.name)) return next()               // 非业务工具不管
    await ensureLoaded()                                    // 首次现拉,消除时序竞态
    if (!cacheOk || cached === null)
      return { kind: 'deny', reason: `业务权限拉取失败,拒绝 ${exec.name}(fail-closed)` }
    if (cached.includes(exec.name)) return { kind: 'allow' }
    return { kind: 'deny', reason: `无权限调用「${exec.name}」;身份 ${config.identity} 仅授权:${cached.join('、') || '无'}` }
  })
}
```

**三个真实工程点**:
1. **懒加载而非 session-start 加载**——会话开始时异步拉取可能晚于首次工具调用,导致误判「未就绪」。改为首次业务工具调用时 `await ensureLoaded()`,`inflight` 去重防并发重复拉取。
2. **授权清单注入模型,但不信任模型自觉**——注入让模型少做无效调用(体验好),但真正的门禁是 pre-execute。永远假设模型会尝试调用未授权工具。
3. **非业务工具透传**——业务权限插件只管自研工具,`bash`/`read` 等交回宿主(可能还有案例一那套命令级门禁在管)。两类门禁可叠加。

### 案例二做的 YAGNI 取舍

规则来源默认 `static`(离线,同事无内网接口也能完整体验),生产才切 `api`。没做权限的实时失效/推送更新(缓存到会话结束),没做细到「工具+参数」级的业务鉴权(只到工具名级)——够用即可。

---

## 两个案例的共性(可直接复用的心智模型)

| 维度 | 案例一(命令级) | 案例二(业务级) |
|---|---|---|
| 规则针对 | 命令内容 / 文件路径 | 调用者身份 |
| 规则来源 | 本地分层配置 | static 本地 / api 后端 |
| 决策内核 | `decide()` 5 步纯函数 | 身份→白名单查表 |
| fail-closed | 安全底线不可降级,配置层可降级 | 拉取失败一律拒,区分「无权限/拉取失败」 |
| 集成壳 | 挂 pre-execute + 降级 | 挂 pre-execute + 懒加载缓存 |
| 非目标工具 | passthrough 交回宿主 | 非业务工具 next() 透传 |

**一句话**:决策流水线、fail-closed 原则、纯函数内核 + 薄集成壳这套骨架两个案例完全一致,变的只有「规则从哪来、匹配什么」。设计新场景时,先套这套骨架,再只想清楚「我的规则来源和匹配目标是什么」。


