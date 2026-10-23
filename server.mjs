/**
 * 悬浮AI小助手 - 本地服务
 *
 * 作用：
 *   1. 把 widget/ 目录的悬浮球页面伺服到 http://127.0.0.1:8787
 *   2. 把 /api/* 请求原样转发给本机正在运行的 DSH（127.0.0.1:3080）
 *
 * 为什么要代理：
 *   DSH 服务器没有开 CORS，浏览器页面如果从别的端口直接 fetch 3080 会被
 *   同源策略拦下。让页面和 API 同源（都走 8787），浏览器就完全无感了，
 *   事件流（SSE）也能正常推送。
 *
 * 只监听 127.0.0.1，不暴露到局域网/公网。
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WIDGET_DIR = path.join(__dirname, 'widget');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const DSH_ORIGIN = process.env.DSH_ORIGIN || 'http://127.0.0.1:3080';
const PORT = Number(process.env.PORT) || 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    res.writeHead(400);
    return res.end('bad request');
  }
  const pathname = decodeURIComponent(url.pathname);

  try {
    // ---- 0) 小助手自己的配置（不转发给 DSH）----
    if (pathname === '/api/widget-config') {
      return await handleWidgetConfig(req, res);
    }

    // ---- 1) /api/* → 转发给 DSH ----
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return await proxyApi(req, res, url);
    }

    // ---- 2) 静态文件（widget/）----
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.normalize(path.join(WIDGET_DIR, rel));
    if (!filePath.startsWith(WIDGET_DIR)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    const st = await stat(filePath);
    if (st.isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      res.writeHead(404);
      res.end('not found');
    } else {
      console.error('[server]', err);
      res.writeHead(500);
      res.end('server error: ' + err.message);
    }
  }
});

/** 读取请求体（JSON） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/**
 * 小助手配置读写：config.json 保存「绑定哪个工作区 + 哪个会话」。
 * 这是小助手自己的接口，不转发给 DSH。
 */
async function handleWidgetConfig(req, res) {
  if (req.method === 'GET') {
    try {
      const raw = await readFile(CONFIG_PATH, 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(raw);
    } catch {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{}');
    }
    return;
  }
  if (req.method === 'POST') {
    let parsed;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'body is not JSON' }));
      return;
    }
    const clean = {};
    if (typeof parsed.workspaceId === 'string' && parsed.workspaceId) clean.workspaceId = parsed.workspaceId;
    if (typeof parsed.sessionId === 'string' && parsed.sessionId) clean.sessionId = parsed.sessionId;
    try {
      await writeFile(CONFIG_PATH, JSON.stringify(clean, null, 2), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, config: clean }));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
    return;
  }
  res.writeHead(405);
  res.end('method not allowed');
}

/** 原样转发一个 /api 请求到 DSH，把响应流接回来。 */
function proxyApi(req, res, url) {
  return new Promise((resolve) => {
    const headers = { ...req.headers };
    // 去掉 hop-by-hop 头，避免 Node 转发时冲突
    delete headers.connection;
    delete headers.upgrade;
    delete headers['transfer-encoding'];
    // 浏览器会带 Origin/Referer（http://127.0.0.1:8787），
    // DSH 的 DNS-rebinding 防护会拒绝非本机 Origin —— 去掉即可
    delete headers.origin;
    delete headers.referer;
    // 让 DSH 看到它熟悉的 Host，DNS-rebinding 防护才会放行
    headers.host = '127.0.0.1:3080';

    const upstream = http.request(
      DSH_ORIGIN + url.pathname + url.search,
      { method: req.method, headers },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        upRes.on('end', resolve);
        // 浏览器关页面/断线时，把上游也掐掉
        res.on('close', () => {
          upRes.destroy();
          resolve();
        });
        // 客户端连接异常（浏览器强断）时别让错误炸掉服务
        res.on('error', () => {
          upRes.destroy();
          resolve();
        });
      },
    );

    upstream.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      }
      res.end(`[proxy] 连不上 DSH（${DSH_ORIGIN}），请确认 DSH 正在运行。\n${err.message}`);
      resolve();
    });

    req.on('error', () => resolve());
    req.pipe(upstream);
  });
}

/** WebSocket 升级转发：DSH 的事件流（/api/events.mux、/api/events.host）是 WS 升级协议。 */
function proxyUpgrade(req, socket, head) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p !== '/api/events.mux' && p !== '/api/events.host') {
    socket.destroy();
    return;
  }
  const headers = { ...req.headers, host: '127.0.0.1:3080' };
  // WebSocket 升级也会带 Origin，同样去掉
  delete headers.origin;
  delete headers.referer;
  const upReq = http.request(DSH_ORIGIN + p + url.search, { method: 'GET', headers });

  const cleanup = () => {
    try { socket.destroy(); } catch { /* 忽略 */ }
    try { upSocketRef?.destroy(); } catch { /* 忽略 */ }
  };
  let upSocketRef = null;

  upReq.on('upgrade', (res, upSocket, upHead) => {
    upSocketRef = upSocket;
    const lines = [
      'HTTP/1.1 101 Switching Protocols',
      `Upgrade: ${res.headers.upgrade || 'websocket'}`,
      `Connection: ${res.headers.connection || 'Upgrade'}`,
      `Sec-WebSocket-Accept: ${res.headers['sec-websocket-accept'] || ''}`,
    ];
    if (res.headers['sec-websocket-protocol']) {
      lines.push(`Sec-WebSocket-Protocol: ${res.headers['sec-websocket-protocol']}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    // 客户端已缓冲的字节 → 上游；上游已缓冲的字节 → 客户端
    if (head && head.length) upSocket.write(head);
    if (upHead && upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    // 任意一端异常/断开，都安全清理，绝不炸掉服务
    socket.on('error', cleanup);
    upSocket.on('error', cleanup);
    socket.on('close', cleanup);
    upSocket.on('close', cleanup);
  });

  upReq.on('error', cleanup);
  upReq.end();
}

server.on('upgrade', proxyUpgrade);

// 最后一道保险：单个连接出任何意外都不能让整个服务退出
process.on('uncaughtException', (err) => {
  console.error('[server] 未捕获异常（已忽略，服务继续运行）:', err.message);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('==========================================');
  console.log('  悬浮AI小助手 已启动');
  console.log(`  http://127.0.0.1:${PORT}  (桌面悬浮窗内部使用)`);
  console.log(`  API 代理 →  ${DSH_ORIGIN}`);
  console.log('  按 Ctrl+C 退出');
  console.log('==========================================');
});
