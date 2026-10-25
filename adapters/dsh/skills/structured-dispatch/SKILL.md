---
name: structured-dispatch
description: 当用户想把某个 subagent 的输出焊死成结构化结果（固定枚举选择 / 开放选项+置信度 / 固定字段），或让主 agent 派发 subagent 并拿回「简洁的开放字段和选择」时使用。典型场景：分类路由、从若干候选里选一个、给出带置信度的几个方案、把调研结论压成可解析 JSON。本 skill 只定义「怎么派发」与「约定哪些输出形状」，真正的硬约束由同仓库的代理补丁（强制工具调用）完成；未装补丁时退化为软约束（提示词要求），照样可用。
---

# structured-dispatch · 让 subagent 返回固定结构的派发协议（DSH / Claude Code）

本 skill 是 **Instructor 思路在 DSH 上的落地形态**：用一份「输出形状」锁死某个 subagent 的返回，
主 agent（你）拿到的是可直接 `JSON.parse` 的干净结果，而不是要自己正则扒的自由文本。

> 为什么不用 `response_format`？因为 DSH / Claude Code 的 subagent 走的是 vLLM 的
> **Anthropic `/v1/messages` 端点，该端点静默忽略 `response_format` / `guided_json` / `extra_body`**。
> 所以本插件改用「把输出形状定义成一个 function，用 `tool_choice` 强制它，再把 `tool_use` 剥壳成纯文本 JSON」
> —— 在你们这台 fork 上实测完美生效。这等价于 Instructor 的 `response_model`，只是换了实现层。

---

## 派发原则（goal-template）· 决策型任务强烈推荐用派发 subagent

> **索引 / 一句话**：当一个子任务只需要「决策 / 分类 / 选择 / 抽取」这类**确定性输出**，
> 不要在主 agent 里让它自由生成长篇推理+结论，而是把它**派发给一个结构化 subagent**，
> 让它只返回极小的固定结构（choice 或 open_choice+置信度）。
> **这能极大减少 decode 负担——如果子任务只需要决策，强烈推荐走这个派发。**

### 为什么能极大减少 decode 负担

decode（生成 token）是按**输出 token 数**吃算力的，尤其你这台 4×V100 是 **KV-bound**
（每多产一个 token 就要多一次 KV 重读 + attention），少产 token = 少占 decode 步数、低延迟、省显存。

| 做法 | subagent 实际产出的 token | 形态 |
|---|---|---|
| 主 agent 自由生成「推理+结论」 | ~300–800 token 散文 | 自由文本，要正则扒 |
| 派发 `router`（choice） | ~20–40 token（一个 `tool_use` 参数） | `{"action":"calculator"}` |
| 派发 `brief`（极简开放选项） | ~60–140 token（3 条 label/confidence/reason+summary） | 干净 JSON |

- 少产 **1 个数量级** 的输出 token → decode 步数、墙钟延迟、KV 占用同比例下降。
- 主 agent 拿到的是 `JSON.parse` 即得的结构化结果，**不用再 parse 自由文本**，解析错误率也低。
- 主 agent 自己的上下文不会被 subagent 的冗长推理污染（subagent 的 thinking 在代理层被剥离）。

### 什么时候该用（决策型 → 强推） / 不该用（生成型）

| 子任务类型 | 是否用派发 subagent | 形状 |
|---|---|---|
| 路由 / 分类（从候选选一个） | ✅ 强推 | `router` |
| 给几个带置信度的方案（决策辅助） | ✅ 强推 | `brief` / `advisor` |
| 抽取固定字段 / 表单填充 | ✅ 强推 | `ticket` |
| 需要长文、创作、解释性输出 | ❌ 不该用 | 普通自由输出 |
| 需要多轮工具调研再总结 | ❌ 本路径不支持 | 走 OpenAI 端 `researcher` 两段式 |

### goal-template 长什么样（主 agent 派发时的指令模板）

```
你要把这个子任务派发出去。它是一个「决策型」任务，不需要长文。
目标：<用一句话说清要决策什么>
候选 / 期望：<router 给枚举；brief 说"给最多 3 个方案带置信度">
派发方式：给 subagent 配 model: qwen3.8-27b-w8a16__schema=<router|brief|advisor|ticket>
拿到返回后直接 JSON.parse 使用，不要让我（主 agent）重写结论。
```

---

## 三种输出形状（注册表 `agents.json`）

| key | 形状 | 返回示例 | 适用 |
|---|---|---|---|
| `router` | 固定枚举 choice | `{"action":"calculator"}` | 二/多分类路由，只能从候选选一个 |
| `brief` | **极简开放选项 + 置信度** | `{"options":[{"label":"先用OA提","confidence":0.85,"reason":"最省事"}],"summary":"走OA"}` | subagent 快速给结论，最多 3 条、理由一句话 |
| `advisor` | 开放选项 + 置信度（更全） | 同上但 `options` 不限条数、`reason` 可长 | 需要更充分论证时 |
| `ticket` | 固定字段（enum 约束） | `{"priority":"HIGH","assignee":"alice"}` | 结构化工单/表单 |

加新形状 = 在 `agents.json` 加一个条目（`input_schema` 就是该 subagent 的输出结构）。
形状语法是标准 JSON Schema（`type`/`properties`/`required`/`enum`/`minimum`…），**开放内容用 `type:string` 不写 `enum`**（模型临场生成），**固定候选用 `enum`**。

## 怎么派发（主 agent 该怎么做）

两种识别方式，二选一：

**方式 A — model 后缀（推荐，硬约束）**
给 subagent 配的模型写成 `<基座模型>__schema=<key>`，例如：
```
model: qwen3.8-27b-w8a16__schema=brief
```
代理会自动剥掉 `__schema=brief` 再发给 vLLM（避免 404），并按 `brief` 强制工具调用。
subagent 最终返回的就是剥壳后的干净 JSON 字符串，你直接解析即可。

**方式 B — HTTP 头 `X-Agent-Name: <key>`**
自研 harness / 能自定义请求头的场景用这个；效果同 A。

**方式 C — 软约束（没装代理补丁时）**
在 subagent 的 system prompt 里写「必须只返回如下 JSON：{...}」并给模板。
这是提示词级约束，不是焊死，但结构基本能保住，且任何端点都能用。

## 你（主 agent）拿回来的是什么

- 装了代理补丁（方式 A/B）：subagent 文本就是 **合法 JSON 字符串**（代理把 `tool_use` 的参数剥出来还原的），
  形如 `{"options":[{"label":"...","confidence":0.85,"reason":"..."}],"summary":"..."}`。
  `confidence` 已被插件 clamp 到 [0,1]，可直接当概率用。
- 没装补丁（方式 C）：subagent 文本里夹 JSON，按需 `JSON.parse` 或正则提取。

## 派发示例（给 subagent 的 user 指令怎么写）

> 「你是分类器。用户问：帮我算 123×456。用你的结构化输出返回路由动作（候选：search/calculator/translate/refund）。」

> 「你是顾问。用户想请假但不确定流程。给出最多 3 个方案，每条带置信度(0~1)和一句话理由，最后一句 summary。」

## 加一个新形状（用户「设置」的入口）

编辑同仓库 `agents.json`，加一项：
```json
"my_shape": {
  "description": "一句话说明这个 subagent 干什么",
  "input_schema": {
    "type": "object",
    "properties": {
      "verdict": { "type": "string", "enum": ["yes", "no", "maybe"] },
      "score": { "type": "number", "minimum": 0, "maximum": 1 }
    },
    "required": ["verdict", "score"]
  }
}
```
然后派发时用 `model: ...__schema=my_shape`。无需重启代理（注册表运行时读取）。

## 与其他能力的边界

- **工具调研 + 结构化汇报（two-phase）**：本插件的 Anthropic 路径做不了——强制工具会锁死单个输出工具，
  无法同时跑多个真实工具。需要「subagent 先自由调工具调研、再压成结构化结论」的，走 OpenAI 端点的
  Python harness（`vllm_structured_agents.py` 的 `researcher` 两段式），不在本 skill 范围内。
- 普通请求（不带 `__schema=` / `X-Agent-Name`）完全不受影响，照常自由输出。
