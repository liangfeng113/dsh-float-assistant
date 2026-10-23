/**
 * 端到端自检脚本：通过本地代理走一遍「建会话 → 发消息 → 流式收回复」全流程。
 * 用法：先启动 server.mjs，再执行 `node e2e-test.mjs`
 * 环境变量：BASE（默认 http://127.0.0.1:8787）
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const TIMEOUT_MS = 120_000;

async function rpc(method, payload) {
  const rpcId = crypto.randomUUID();
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.result.ok) {
    throw new Error(`${data.result.error?.code || 'error'}: ${data.result.error?.message || JSON.stringify(data.result.error)}`);
  }
  return data.result.value;
}

function extractText(blocks) {
  return Array.isArray(blocks)
    ? blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
    : '';
}

async function main() {
  console.log('1) host.describe …');
  const desc = await rpc('host.describe', {});
  console.log('   →', desc.provider, '/', desc.model, `（当前 ${desc.attachedSessions} 个会话）`);

  console.log('2) session.create …');
  const { sessionId } = await rpc('session.create', {});
  console.log('   →', sessionId);

  console.log('3) 连接事件流 ws://…/api/events.mux 并发消息 …');
  let fullText = '';

  const done = new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/api/events.mux`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('等待回复超时')); }, TIMEOUT_MS);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        const frame = msg.payload;
        if (frame?.type !== 'session/event' || frame.sessionId !== sessionId) return;
        const ev = frame.event;
        if (ev.type === 'assistant/chunk' && ev.data?.chunk?.type === 'text-delta') {
          fullText += ev.data.chunk.text;
          process.stdout.write(ev.data.chunk.text);
        } else if (ev.type === 'assistant/message') {
          fullText = extractText(ev.data?.message?.content) || fullText;
        } else if (ev.type === 'turn/end') {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve();
        }
      } catch (err) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(err);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('事件流连接失败'));
    };
    ws.onclose = () => {
      clearTimeout(timer);
      if (fullText.length === 0) reject(new Error('事件流意外关闭，未收到回复'));
    };
  });

  await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '请只用一句话介绍你自己。' }],
    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });

  await done;
  console.log('\n\n4) ✅ 收到完整回复，共', fullText.length, '字符');
  console.log('测试会话 id：', sessionId, '（可在 DSH 界面里看到它）');
}

main().catch((e) => {
  console.error('\n❌ 自检失败：', e.message);
  process.exit(1);
});
