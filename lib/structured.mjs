// structured.mjs
// =====================================================================
// DSH 结构化输出插件 —— 核心注入 / 还原模块（ESM，可被 proxy.mjs import）
//
// 背景（实测，2026-10-25，1Cat vLLM 1.5.0 / Qwen3-27B-W8A16）：
//   - vLLM 的 Anthropic /v1/messages 端点【不认】response_format /
//     guided_json / extra_body（全部静默忽略，吐自由文本）。
//   - 但【强制工具调用】生效：把"输出形状"定义成一个 function 的
//     input_schema，再用 tool_choice 把它锁死，模型只会吐这个 tool 的
//     input（= 焊死的结构化输出）。这是 Anthropic 原生机制，且 Claude Code
//     的 subagent 走的就是 /v1/messages。
//
// 本模块做两件事：
//   1) injectStructured(body, agentKey)：给请求体注入"强制输出工具"。
//   2) unwrapStructured(blocks, agentKey)：把上游返回的 tool_use 块剥壳，
//      还原成纯文本 JSON，让调用方（Claude Code subagent）当普通文本读，
//      无需它自己理解工具。
//
// agent 识别（二选一，按优先级）：
//   - HTTP 头 X-Agent-Name: <key>
//   - model 字段后缀 __schema=<key>（Claude Code subagent 可在 frontmatter
//     里设 model: qwen3.8-27b-w8a16__schema=router，无需改客户端代码）
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --------------------------- 默认 agent 注册表 ---------------------------
// 每个 agent 的输出"形状"用 Anthropic 原生 tool input_schema 表达。
// 想加/改 agent，编辑仓库根的 agents.json（会覆盖下面这些默认值）。
const DEFAULT_AGENTS = {
  // 固定枚举路由（choice）
  router: {
    description: '二/多分类路由动作；只能从给定候选里选一个。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'calculator', 'translate', 'refund'] },
      },
      required: ['action'],
    },
  },
  // 形状固定、内容自由：开放选项 + 置信度（open_choice）—— 你要的核心需求
  advisor: {
    description: '给出若干可能方案，每条带置信度(0~1)与理由。形状固定，label/summary 内容自由生成。',
    input_schema: {
      type: 'object',
      properties: {
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              reason: { type: 'string' },
            },
            required: ['label', 'confidence', 'reason'],
          },
        },
        summary: { type: 'string' },
      },
      required: ['options', 'summary'],
    },
  },
  // 固定结构提取 / 分类（json）
  ticket: {
    description: '工单分类：固定结构，字段取值受 enum 约束。',
    input_schema: {
      type: 'object',
      properties: {
        priority: { type: 'string', enum: ['LOW', 'HIGH'] },
        assignee: { type: 'string', enum: ['alice', 'bob'] },
      },
      required: ['priority', 'assignee'],
    },
  },
};

// 被冻结工具的固定名（inject 时用它，unwrap 时也认它）
export const STRUCT_TOOL_NAME = 'structured_output';

let AGENTS = { ...DEFAULT_AGENTS };

// 加载 agents.json（仓库根；可用环境变量 STRUCTURED_AGENTS_JSON 覆盖路径）。
// 调用方 import 本模块时即自动执行一次（模块副作用）。
export function loadStructuredRegistry(customPath) {
  // 兼容两种布局：模块与 agents.json 同目录（安装到代理旁时），或 agents.json 在仓库根（开发时）。
  const candidates = [
    customPath,
    process.env.STRUCTURED_AGENTS_JSON,
    path.join(__dirname, 'agents.json'),
    path.join(__dirname, '..', 'agents.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        AGENTS = { ...DEFAULT_AGENTS, ...j };
      } catch (e) {
        console.error('[structured] agents.json 解析失败，沿用默认注册表:', e?.message || e);
      }
      break;
    }
  }
  return AGENTS;
}
loadStructuredRegistry();

export function getAgents() { return AGENTS; }

// ----------------------------- agent 识别 ------------------------------
export function detectStructuredAgent(model, headerName) {
  if (headerName && AGENTS[headerName]) return headerName;
  if (typeof model === 'string') {
    const m = model.match(/__schema=([A-Za-z0-9_.\-]+)/);
    if (m && AGENTS[m[1]]) return m[1];
  }
  return null;
}

// --------------------------- 注入强制输出工具 ---------------------------
// 直接改写传入的 body（上游透传）。返回是否注入了。
// 注意：若 agent 经 model 后缀 __schema=<key> 识别，这里会把后缀从 model 字段
// 剥掉，否则上游会因为不认识这个模型名而 404。
export function injectStructured(body, agentKey) {
  const spec = AGENTS[agentKey];
  if (!spec) return false;
  if (typeof body.model === 'string') {
    body.model = body.model.replace(/__schema=[A-Za-z0-9_.\-]+/, '');
  }
  body.tools = [{ name: STRUCT_TOOL_NAME, description: spec.description, input_schema: spec.input_schema }];
  body.tool_choice = { type: 'tool', name: STRUCT_TOOL_NAME };
  // 保险：强制工具模式下不需要 thinking（避免思考文本混进工具参数）
  if (body.enable_thinking !== undefined) body.enable_thinking = false;
  return true;
}

// ------------------------- 把 tool_use 还原成文本 ------------------------
// 上游在强制工具下只会返回一个 tool_use 块（structured_output）。
// 把它剥壳成纯文本 JSON，客户端当普通文本/JSON 读，无需理解工具。
export function unwrapStructured(contentBlocks, agentKey) {
  if (!Array.isArray(contentBlocks)) return contentBlocks;
  const out = [];
  let found = false;
  for (const b of contentBlocks) {
    if (b && b.type === 'tool_use' && b.name === STRUCT_TOOL_NAME) {
      found = true;
      let text;
      try { text = JSON.stringify(b.input ?? {}, null, 2); }
      catch { text = String(b.input ?? ''); }
      out.push({ type: 'text', text });
    } else if (b && b.type === 'text' && !found) {
      out.push(b); // 理论上 forced 模式下不会有，但保留以防万一
    }
  }
  return found ? out : contentBlocks;
}
