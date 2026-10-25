# dsh-structured-output

DSH / Claude Code 插件：**把 subagent 的输出焊死成固定结构**，模型只有一个，每个 agent 在注册表里配不同 schema。

- **固定枚举 choice**（`router`）：只能从给定候选选一个。
- **开放选项 + 置信度 open_choice**（`advisor`）：形状固定，但 `label`/理由/汇总内容**自由生成**，每条带 `confidence`(0~1)。
- **固定 json**（`ticket`）：填一个固定结构，字段取值受 enum 约束。
- **极简开放选项 + 置信度**（`brief`）：`advisor` 的精简版，最多 3 条、理由一句话、summary 一句——subagent **快速给结论**用。
- **非结构化 free**：不带标记的请求完全不受影响（默认行为）。

> 你的两个需求都覆盖：
> 1. 形状固定、choice 自由填、按情景输出"可能的选项 + 置信度" → `open_choice`。
> 2. 不同 agent 配不同 schema → 注册表里每个 agent 一个条目，按来源识别。

---

## 为什么用"强制工具调用"而不是 `response_format`

实测（1Cat vLLM 1.5.0 / Qwen3-27B-W8A16，2026-10-25）：

| 机制 | Anthropic `/v1/messages` 端点 | OpenAI `/v1/chat/completions` 端点 |
|---|---|---|
| `response_format`(json_schema) | ❌ 静默忽略（吐自由文本） | ✅ 强制生效 |
| `guided_json` / `guided_choice` | ❌ 静默忽略 | `guided_choice` 无效；`guided_regex` ✅ |
| `extra_body` 透传 | ❌ 静默忽略 | — |
| **强制工具调用**（`tool_choice` 锁单个 function） | ✅ **生效** | ✅ 生效 |

DSH / Claude Code 的 subagent 走的是代理的 **Anthropic `/v1/messages`** 端点，而该端点**不认 `response_format`**。本插件因此改用 **强制工具调用**：把"输出形状"定义成一个 function 的 `input_schema`，用 `tool_choice` 把它锁死，模型只会吐这个 tool 的参数（= 焊死的结构化输出）；代理再把返回的 `tool_use` 块**剥壳还原成纯文本 JSON**，调用方（subagent）当普通文本读，无需它自己理解工具。

---

## 安装（代理注入，自动备份）

本插件不改变 vLLM 模型，只在你已有的 `claude-vllm-proxy`（DSH / Claude Code 的 vLLM 翻译代理）里注入补丁。

```bash
cd dsh-structured-output
node install.mjs            # 装到默认 ~/.claude-vllm-proxy/proxy.mjs（自动备份）
# 或指定代理位置：
PROXY_TARGET=/path/to/proxy.mjs node install.mjs
```

- 会把 `lib/structured.mjs` 与 `agents.json` 复制到代理目录旁的 `structured/`，代理重启后不依赖本仓库位置。
- **重启代理后生效**（launchctl kickstart / 等价操作）。
- 卸载（恢复原代理）：`node install.mjs --uninstall`。幂等，重复安装会提示已安装。

---

## 怎么让一个 agent 走结构化输出

两种识别方式，按优先级：

1. **model 后缀**（推荐，Claude Code subagent 可用）：在 subagent 的 `model` 字段后加 `__schema=<key>`。
   ```yaml
   # .claude/agents/router.md 的 frontmatter
   model: qwen3.8-27b-w8a16__schema=router
   ```
   客户端/代理会自动把 `__schema=router` 从 model 字段剥掉再发给 vLLM，避免 404。

2. **HTTP 头**：请求带 `X-Agent-Name: <key>`（自研 harness / 客户端用）。

不带的请求 = 自由输出，完全不进插件逻辑。

---

## 加 / 改 agent

编辑仓库根（或代理目录旁的）`agents.json`：每个 key 一个 agent，`input_schema` 就是它的输出形状（Anthropic 原生 tool schema）。

```json
{
  "router": {
    "description": "二/多分类路由动作",
    "input_schema": {
      "type": "object",
      "properties": { "action": { "type": "string", "enum": ["search","calculator","translate","refund"] } },
      "required": ["action"]
    }
  }
}
```

`open_choice`（开放选项 + 置信度）的形状示例：

```json
{
  "advisor": {
    "description": "给出若干方案，每条带置信度与理由",
    "input_schema": {
      "type": "object",
      "properties": {
        "options": { "type": "array", "items": {
          "type": "object",
          "properties": {
            "label": { "type": "string" },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "reason": { "type": "string" }
          },
          "required": ["label", "confidence", "reason"]
        }},
        "summary": { "type": "string" }
      },
      "required": ["options", "summary"]
    }
  }
}
```

极简版 `brief`（subagent 快速给结论，最多 3 条、理由一句）：

```json
{
  "brief": {
    "description": "极简开放选项：最多 3 个方案，每条带置信度(0~1)与一句话理由；summary 一句话。",
    "input_schema": {
      "type": "object",
      "properties": {
        "options": { "type": "array", "minItems": 1, "maxItems": 3, "items": {
          "type": "object",
          "properties": {
            "label": { "type": "string" },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "reason": { "type": "string", "maxLength": 80 }
          },
          "required": ["label", "confidence", "reason"]
        }},
        "summary": { "type": "string", "maxLength": 120 }
      },
      "required": ["options", "summary"]
    }
  }
}
```

> 开放内容用 `type:string` 不写 `enum`（模型临场生成）；固定候选才用 `enum`。`confidence` 的
> `minimum/maximum` 是软约束（xgrammar 不一定夹值），插件额外 `clamp` 到 [0,1]。

---

## Skill：让 main 派发 subagent 拿回"简洁的开放字段和选择"

仓库内含一个 DSH **skill** `adapters/dsh/skills/structured-dispatch/SKILL.md`。它是本插件的
**"可设置 / 可选择的派发接口"**：

- **选择**：skill 的 `description` frontmatter 让主 agent 在合适场景自动决定启用（分类路由、从候选里选一个、带置信度给方案、把调研结论压成 JSON …）。
- **设置**：skill 正文列出可选的输出形状（router / brief / advisor / ticket），并说明如何**编辑 `agents.json` 加新形状**——这就是"每个 agent 配不同 schema"的用户入口。
- **派发**：主 agent 给 subagent 配 `model: <基座>__schema=<key>`（或 `X-Agent-Name` 头），subagent 返回的就是剥壳后的干净 JSON。

安装本插件（含 postinstall 钩子）后，`dsh plugin add dsh-structured-output` 会自动把 skill 加载进 DSH；
未装代理补丁时，skill 退化成提示词级软约束，照样能引导 subagent 返回结构。

---

## 改完 `agents.json` 后要让改动生效

`agents.json` 在装插件时被复制到代理目录旁的 `structured/`。改完仓库里的 `agents.json` 后，**重跑一次 `node install.mjs`**（幂等，marker 已存在时会跳过重复打补丁、但会刷新复制的 `agents.json`/lib），再重启代理即可。无需 `--uninstall`。

---

## 测试

```bash
# 先装补丁到一个代理（或真实代理），再：
BASE_URL=http://localhost:8787 node test-structured.mjs
```

校验：advisor 返回合法 JSON 且含 `options[]`+`confidence`；router 返回落在 enum 的 `action`；普通请求仍自由文本。

---

## 已知限制

- **调研型 two-phase（工具自由调研 + 结构化汇报）**：本插件在 Anthropic `/v1/messages` 上强制单个输出工具，无法同时跑"多个真实工具 + 强制汇报"。需要该模式的，请用仓库里同思路的 Python harness（在 OpenAI `/v1/chat/completions` 上 `tools` + `response_format` 两段式，已验证）。
- 强制工具模式下会关掉 thinking（避免思考文本混进工具参数）。
- 本插件只动代理转发逻辑，不动模型权重；并发/吞吐行为与原代理一致。

---

## 文件

- `lib/structured.mjs` —— 注入 / 还原核心（ESM，被代理 import）
- `agents.json` —— agent 输出形状注册表（可编辑）
- `install.mjs` —— 代理补丁安装器（备份 / 幂等 / 卸载 / 重跑刷新文件）
- `adapters/dsh/skills/structured-dispatch/SKILL.md` —— DSH skill（让 main 派发 subagent 的"可设置/可选择的派发接口"）
- `cordis.patch.yml` / `plugin-manifest.v1.json` —— DSH 市场元数据
- `test-structured.mjs` —— 端到端测试

License: MIT
