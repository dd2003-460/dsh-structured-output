#!/usr/bin/env node
// test-structured.mjs —— 验证 dsh-structured-output 插件（打过补丁的代理）
// =====================================================================
// 默认打补丁后的代理在 http://localhost:8799（见 install + 启动说明）。
// 也可用 BASE_URL 指向任意已装插件的代理（含 8787）。
//
// 校验三件事：
//   1) model 后缀 __schema=advisor  -> 返回纯文本 JSON，含 options[] + confidence
//   2) X-Agent-Name: router         -> 返回纯文本 JSON，含 action（落在 enum）
//   3) 普通请求（无 schema）          -> 仍正常自由输出（补丁不破坏其他请求）
// =====================================================================
import { detectStructuredAgent, injectStructured, unwrapStructured, loadStructuredRegistry } from './lib/structured.mjs';

const BASE = process.env.BASE_URL || 'http://localhost:8799';
loadStructuredRegistry();

async function postMessages(payload, headers = {}) {
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'x', ...headers },
    body: JSON.stringify(payload),
  });
  const ct = r.headers.get('content-type') || '';
  const raw = await r.text();
  let body;
  if (/text\/event-stream/i.test(ct)) {
    // 聚合 SSE（与代理 synthesizeStream 对齐的简单实现）
    body = { type: 'message', role: 'assistant', content: [], model: 'x' };
    let text = '';
    for (const frame of raw.split('\n\n')) {
      const m = frame.match(/^data:\s*([\s\S]*)$/m);
      if (!m) continue;
      let o; try { o = JSON.parse(m[1].trim()); } catch { continue; }
      if (o.type === 'content_block_delta' && o.delta?.text) text += o.delta.text;
    }
    if (text) body.content.push({ type: 'text', text });
  } else {
    try { body = JSON.parse(raw); } catch { body = { content: [{ type: 'text', text: raw }] }; }
  }
  return { status: r.status, body };
}

function extractText(body) {
  if (!body || !Array.isArray(body.content)) return '';
  return body.content.filter(b => b.type === 'text').map(b => b.text || '').join('');
}

let ok = true;
function check(label, cond, detail) {
  ok = ok && cond;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
}

async function main() {
  console.log('=== test-structured @ ' + BASE + ' ===');

  // 1) advisor 经 model 后缀
  {
    const { status, body } = await postMessages({
      model: 'qwen3.8-27b-w8a16__schema=advisor',
      max_tokens: 800, stream: true,
      messages: [{ role: 'user', content: '用户想请假但不确定流程，给几个方案。' }],
    });
    const txt = extractText(body);
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch {}
    console.log('  [advisor] status=' + status + ' text=' + txt.slice(0, 120).replace(/\n/g, ' '));
    check('advisor: 返回合法 JSON', !!parsed);
    check('advisor: 含 options 数组且非空', parsed && Array.isArray(parsed.options) && parsed.options.length > 0);
    check('advisor: 每条有 label(字符串)+confidence(数字)',
      parsed && parsed.options.every(o => typeof o.label === 'string' && o.label.trim() && typeof o.confidence === 'number'));
    check('advisor: summary 为字符串', parsed && typeof parsed.summary === 'string');
  }

  // 2) router 经 X-Agent-Name 头
  {
    const { status, body } = await postMessages({
      model: 'qwen3.8-27b-w8a16',
      max_tokens: 300, stream: false,
      messages: [{ role: 'user', content: '用户问：帮我算 123*456。' }],
    }, { 'X-Agent-Name': 'router' });
    const txt = extractText(body);
    let parsed = null;
    try { parsed = JSON.parse(txt); } catch {}
    console.log('  [router] status=' + status + ' text=' + txt.slice(0, 120));
    check('router: 返回合法 JSON', !!parsed);
    check('router: action 落在 enum', parsed && ['search', 'calculator', 'translate', 'refund'].includes(parsed.action));
  }

  // 3) 普通请求不受影响
  {
    const { status, body } = await postMessages({
      model: 'qwen3.8-27b-w8a16',
      max_tokens: 120, stream: false,
      messages: [{ role: 'user', content: '用一句话介绍前缀缓存。' }],
    });
    const txt = extractText(body);
    console.log('  [free] status=' + status + ' text=' + txt.slice(0, 120).replace(/\n/g, ' '));
    check('free: 正常自由文本（非 JSON 结构）', status === 200 && txt.length > 0 && !txt.trim().startsWith('{'));
  }

  console.log('\n' + (ok ? '全部通过 ✅' : '存在失败 ❌'));
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error('TEST ERR', e); process.exit(1); });
