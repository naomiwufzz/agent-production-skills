# intents.yml 契约

本文档是一个可移植的 `intents.yml` 字段契约示例。具体字段和校验规则应由宿主项目自行冻结。

---

## 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `version` | 整数 `1` | 是 | 固定值 `1`（写成字符串 `'1'` 或 `'1.0'` 会抛错） |
| `slots` | `Slot[]` | 否 | 跨意图共享的全局槽定义；`parseIntentSpec` 缺省补空数组 |
| `intents` | `IntentDef[]` | 是 | 意图列表，**必须非空** |

---

## Slot 字段详解

```typescript
interface Slot {
  name: string           // 槽标识，蛇形命名
  desc?: string          // 人读描述（可选）
  source: SlotSource     // 填充方式，见下表
  type?: string          // 值的类型提示（可选，纯注解）
  globalRequired?: boolean  // 仅顶层 slots 有意义，见下方说明
  required?: boolean     // 仅意图私有 slots 有意义，见下方说明
}

type SlotSource = 'ask_user' | 'auto_fetch'
```

### `source` 含义

| 值 | 含义 |
|---|---|
| `ask_user` | agent 需向用户主动询问才能得到这个值 |
| `auto_fetch` | agent 可自行查取（日志、API、工具调用等），无需打扰用户 |

### `globalRequired` vs `required`

- **`globalRequired: true`**：仅用于**顶层 `slots`**（全局槽）。标记此槽对**所有意图**都必须先收集，agent 在任何意图下都会检查它。
- **`required: true`**：仅用于**意图私有 `slots`**（意图下的 `slots[]`）。标记此槽对当前意图必填。

全局槽的 `required` 字段在代码层面**不会被** `requiredSlotsFor` 识别——只认 `globalRequired`；意图槽同理只认 `required`，不认 `globalRequired`。

---

## IntentDef 字段详解

```typescript
interface IntentDef {
  name: string        // 意图标识，蛇形命名，不可与保留意图重名
  desc: string        // 意图描述，必填且非空（parseIntentSpec 硬校验）
  boundary?: string   // 意图边界说明——描述哪些场景属于/不属于本意图（可选，用于分流歧义）
  slots?: Slot[]      // 意图私有槽（可选），用 required 标必填
  fewshot?: FewShot[] // 少样本示例（可选），帮助模型对齐识别边界
}
```

### `boundary`

在多个意图语义相近时，`boundary` 用一句话划清边界：

```yaml
- name: white_screen
  desc: 页面白屏/加载不出来
  boundary: 页面渲染为空白;不含"能渲染但点击无响应"
```

### `fewshot`

```typescript
interface FewShot {
  input: string                    // 用户原始话语
  intent: string                   // 目标意图名
  slots?: Record<string, unknown>  // 对应槽值（可选）
}
```

注意字段名是**单数** `fewshot`（无复数 s）：

```yaml
fewshot:
  - input: 客户说报告页打开一片白
    intent: white_screen
```

---

## 保留意图约束

以下三个意图名是系统保留，**不可出现在 `intents` 列表里**：

| 名称 | 含义 |
|---|---|
| `unclear` | 信息不足，待澄清 |
| `unsupported` | 域外任务，拒识 |
| `meta` | 非任务的元问题/闲聊，正常作答 |

`parseIntentSpec` 检测到自定义意图与这三个名字重复时，直接抛错。它们由 runtime 在推理层自动产生，无需在 `intents.yml` 中定义。

---

## parseIntentSpec 校验清单

以下规则来自 `packages/dsh-intent/src/intents.ts` 的 `parseIntentSpec` 函数，逐一对应：

1. **顶层必须是对象**：`parseYaml` 结果为 `null` 或非对象，抛 `intents.yml 顶层必须是对象`。
2. **version 必须为整数 1**：`raw.version !== 1` 则抛错；`'1'`、`'1.0'`、`2` 均不合法。
3. **intents 必须是非空数组**：`!Array.isArray(intents) || intents.length === 0` 则抛错。
4. **每个意图 name 非空**：`typeof it.name !== 'string' || it.name.trim() === ''` 则抛错。
5. **每个意图 desc 非空**：`typeof it.desc !== 'string' || it.desc.trim() === ''` 则抛错（提示: `意图 <name> 缺 desc`）。
6. **意图名不撞保留字**：名称命中 `RESERVED_INTENTS`（`unclear`/`unsupported`/`meta`）则抛错。
7. **意图名不重复**：重名则抛错（提示: `意图名重复(duplicate): <name>`）。
8. **顶层 slots 缺省处理**：`raw.slots` 不是数组时，`parseIntentSpec` 返回空数组 `[]`，不抛错。

---

## 最小可用示例

可直接复制为起步文件，可运行：

```yaml
version: 1

# 全局槽：所有意图共享
slots:
  - name: customer_no
    desc: 客户号/租户标识
    source: ask_user
    globalRequired: true
  - name: env
    desc: 环境(线上/UAT/SIT)
    source: ask_user
    globalRequired: true

intents:
  - name: white_screen
    desc: 页面白屏/加载不出来
    boundary: 页面渲染为空白;不含"能渲染但点击无响应"
    slots:
      - name: page_url
        desc: 白屏页面地址
        source: ask_user
        required: true
      - name: console_error
        desc: 控制台报错
        source: auto_fetch
        required: true
    fewshot:
      - input: 客户说报告页打开一片白
        intent: white_screen

  - name: api_502
    desc: 接口 502/网关错误
    slots:
      - name: api_path
        desc: 报错接口路径
        source: ask_user
        required: true

  - name: other_frontend
    desc: 前端问题但不属以上枚举(兜底,仍在领域内)
```

> 槽位解析优先级：意图私有槽 > 顶层全局槽。`requiredSlotsFor(spec, intentName)` 合并 `globalRequired` 全局槽 + 意图内 `required` 槽，返回必填名称列表。
