#!/usr/bin/env node
// install.mjs —— DSH 结构化输出插件安装器
// =====================================================================
// 把"按 Agent 强制结构化输出"补丁装进用户的 claude-vllm-proxy（DSH / Claude
// Code 的 vLLM 翻译代理）。该代理同时服务 Anthropic /v1/messages（Claude Code
// subagent 走这条）。由于 vLLM 的 /v1/messages 不认 response_format，本补丁改用
// "强制工具调用 + 响应剥壳"实现（见 lib/structured.mjs）。
//
// 用法：
//   node install.mjs                安装（自动备份，幂等）
//   node install.mjs --uninstall    卸载（从备份恢复）
//   node install.mjs --dry          只打印将要写入的改动，不落盘
//   node install.mjs --target <path> 指定要打补丁的 proxy.mjs（测试用副本）
//
// 环境变量：
//   PROXY_TARGET   proxy.mjs 路径（默认 ~/.claude-vllm-proxy/proxy.mjs）
// =====================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = __dirname;

// 把模块 + 注册表安装到代理目录旁（<proxyDir>/structured/），使代理重启后
// 不依赖本仓库位置，也不会因仓库移动而崩。
function installModuleNextToProxy(proxyTarget) {
  const proxyDir = path.dirname(proxyTarget);
  const destDir = path.join(proxyDir, 'structured');
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(path.join(INSTALL_DIR, 'lib', 'structured.mjs'), path.join(destDir, 'structured.mjs'));
  fs.copyFileSync(path.join(INSTALL_DIR, 'agents.json'), path.join(destDir, 'agents.json'));
  return pathToFileURL(path.join(destDir, 'structured.mjs')).href;
}

const DEFAULT_PROXY = path.join(
  process.env.HOME || '', '.claude-vllm-proxy', 'proxy.mjs'
);
const PROXY_TARGET = process.env.PROXY_TARGET || process.argv.includes('--target')
  ? (() => {
      const i = process.argv.indexOf('--target');
      return i >= 0 ? process.argv[i + 1] : (process.env.PROXY_TARGET || DEFAULT_PROXY);
    })()
  : DEFAULT_PROXY;

const BACKUP_PATH = PROXY_TARGET + '.backup-structured';
const MARK_START = '// ===== STRUCTURED AGENT INJECTION (dsh-structured-output) =====';
const MARK_END = '// ===== END STRUCTURED AGENT INJECTION =====';

const isUninstall = process.argv.includes('--uninstall');
const isDry = process.argv.includes('--dry');

function fail(msg) {
  console.error('[install] ' + msg);
  process.exit(1);
}

if (!fs.existsSync(PROXY_TARGET)) {
  fail(`未找到代理文件: ${PROXY_TARGET}\n请确认 claude-vllm-proxy 已安装，或用 PROXY_TARGET= 或 --target 指定。`);
}

// ---------------- 卸载：从备份恢复 ----------------
if (isUninstall) {
  if (!fs.existsSync(BACKUP_PATH)) fail(`没有备份可恢复: ${BACKUP_PATH}`);
  if (!isDry) fs.copyFileSync(BACKUP_PATH, PROXY_TARGET);
  console.log(`[install] 已从备份恢复: ${PROXY_TARGET}${isDry ? ' (dry)' : ''}`);
  if (!isDry) { fs.unlinkSync(BACKUP_PATH); console.log('[install] 备份已删除'); }
  process.exit(0);
}

// ---------------- 已安装？幂等检查 ----------------
let src = fs.readFileSync(PROXY_TARGET, 'utf8');
if (src.includes('dsh-structured-output')) {
  console.log('[install] 已安装（检测到 dsh-structured-output 标记），无需重复。如需重装请先 --uninstall。');
  process.exit(0);
}

// 备份（仅首次）
if (!fs.existsSync(BACKUP_PATH) && !isDry) {
  fs.copyFileSync(PROXY_TARGET, BACKUP_PATH);
  console.log('[install] 已备份原代理到: ' + BACKUP_PATH);
}

// ---------------- 把模块 + 注册表装到代理目录旁 ----------------
const MODULE_URL = installModuleNextToProxy(PROXY_TARGET);
const IMPORT_LINE = `import { detectStructuredAgent, injectStructured, unwrapStructured, loadStructuredRegistry } from '${MODULE_URL}';`;

// ---------------- 插入 import（锚点：node:child_process 之后） ----------------
const importAnchor = "import { spawn } from 'node:child_process';";
if (!src.includes(importAnchor)) fail('未找到 import 锚点（node:child_process），代理版本可能不兼容。');
if (!src.includes(IMPORT_LINE)) {
  src = src.replace(importAnchor, importAnchor + '\n' + IMPORT_LINE);
}

// ---------------- 插入 /v1/messages 早期返回块（锚点：model 声明之后、上游 fetch 之前） ----------------
// 必须放在 const model = ... 之后，否则块内引用的 wantsStream / model 尚未声明（TDZ）。
const blockAnchor = "const model = reqBody.model || '?';";
if (!src.includes(blockAnchor)) fail('未找到 /v1/messages 注入锚点（const model），代理版本可能不兼容。');

const block = `
  ${MARK_START}
  {
    // 识别结构化 agent：model 后缀 __schema=<key> 或 X-Agent-Name 头
    const _sAgent = detectStructuredAgent(reqBody.model, req.headers['x-agent-name']);
    if (_sAgent) {
      try {
        injectStructured(reqBody, _sAgent);
        log('STRUCTURED_INJECT agent=' + _sAgent + ' model=' + reqBody.model);
        const _sAc = new AbortController();
        const _sDeadline = Date.now() + (parseInt(process.env.UPSTREAM_TIMEOUT_MS || '3600000', 10));
        const _sUp = await fetchUpstream(currentUpstream() + '/v1/messages', () => {
          const _sTimer = setTimeout(() => _sAc.abort(new Error('upstream_total_timeout')), Math.max(1000, _sDeadline - Date.now()));
          return {
            options: {
              method: 'POST', signal: _sAc.signal,
              headers: {
                'Content-Type': 'application/json',
                ...(req.headers.authorization ? { Authorization: req.headers.authorization } : (VLLM_API_KEY ? { Authorization: 'Bearer ' + VLLM_API_KEY } : {})),
                ...(req.headers['x-api-key'] ? { 'x-api-key': req.headers['x-api-key'] } : (VLLM_API_KEY ? { 'x-api-key': VLLM_API_KEY } : {})),
                'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
              },
              body: JSON.stringify({ ...reqBody, stream: true }),
            },
            dispose: () => clearTimeout(_sTimer),
          };
        });
        if (!_sUp.ok) {
          const _sErr = await _sUp.text();
          log('STRUCTURED_UPSTREAM_ERR ' + _sUp.status + ' ' + _sErr.slice(0, 200) + ' —— 回退普通路径');
        } else {
          const _sFull = await _sUp.text();
          const _sAsm = assembleSseToMessage(_sFull);
          const _sFixed = transformResponse(_sAsm);
          _sFixed.content = unwrapStructured(_sFixed.content, _sAgent);
          if (wantsStream) {
            // 客户端要流式：把还原后的纯文本 JSON 作为 SSE 吐出
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            res.write(sseEvent({ type: 'message_start', message: { id: _sFixed.id || ('msg_' + Date.now()), type: 'message', role: 'assistant', model: _sFixed.model || model, content: [], stop_reason: null, stop_sequence: null, usage: _sFixed.usage || { input_tokens: 0, output_tokens: 0 } } }));
            let _si = 0;
            for (const _blk of (_sFixed.content || [])) {
              if (_blk.type === 'text' && _blk.text) {
                res.write(sseEvent({ type: 'content_block_start', index: _si, content_block: { type: 'text', text: '' } }));
                res.write(sseEvent({ type: 'content_block_delta', index: _si, delta: { type: 'text_delta', text: _blk.text } }));
                res.write(sseEvent({ type: 'content_block_stop', index: _si }));
                _si++;
              }
            }
            res.write(sseEvent({ type: 'message_delta', delta: { stop_reason: _sFixed.stop_reason || 'end_turn', stop_sequence: null }, usage: _sFixed.usage || { input_tokens: 0, output_tokens: 0 } }));
            res.write(sseEvent({ type: 'message_stop' }));
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(_sFixed));
          }
          return;
        }
      } catch (e) {
        log('STRUCTURED_ERR ' + (e && e.message ? e.message : e) + ' —— 回退普通路径');
      }
    }
  }
  ${MARK_END}
`;

if (!src.includes(MARK_START)) {
  // 在锚点（const model = ...）之后插入，保证块内能引用 wantsStream / model
  src = src.replace(blockAnchor, blockAnchor + '\n' + block);
}

if (isDry) {
  console.log('[install] === DRY RUN，以下为将要写入的 import ===');
  console.log(IMPORT_LINE);
  console.log('[install] === 以及将要插入的早期返回块（已省略，见 install.mjs）===');
  console.log('[install] 改动行数约: ' + block.split('\n').length);
  process.exit(0);
}

fs.writeFileSync(PROXY_TARGET, src, 'utf8');
console.log('[install] ✅ 已注入结构化输出补丁到: ' + PROXY_TARGET);
console.log('[install] 重启代理后生效（launchctl kick 或等价操作）。');
console.log('[install] 卸载：node install.mjs --uninstall');
