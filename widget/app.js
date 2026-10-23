/**
 * 悬浮AI小助手 - 前端逻辑
 *
 * 与 DSH 的通信协议（实测验证）：
 *   发消息    → POST /api/session.prompt   （JSON 信封）
 *   收事件流  → WS   /api/events.mux       （WebSocket，会话事件）
 *   查/建会话 → POST /api/session.list | session.create
 *   读历史    → POST /api/session.history
 *   停止回复  → POST /api/session.cancel
 *   服务信息  → POST /api/host.describe
 *   工作区    → POST /api/workspace.list
 *
 * 绑定模型：
 *   小助手不自己乱建会话，而是「认领」你在 DSH 里建好的工作区 + 对话。
 *   绑定关系存在项目根目录 config.json（通过 /api/widget-config 读写），
 *   不依赖浏览器缓存 —— 重启、换浏览器都继承同一个对话。
 */
(() => {
  'use strict';

  // ---------- DOM ----------
  const orb = document.getElementById('orb');
  const panel = document.getElementById('panel');
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('btn-send');
  const stopBtn = document.getElementById('btn-stop');
  const modelInfoEl = document.getElementById('model-info');
  const bindBtn = document.getElementById('btn-bind');

  // ---------- 状态 ----------
  let config = { workspaceId: null, sessionId: null }; // 绑定：工作区 + 对话
  let busy = false;
  let streamingEl = null;   // 正在流式输出的气泡
  let muxWs = null;
  let closing = false;
  let bindMode = false;     // 是否在「选择对话」界面

  // ---------- 桌面模式桥接 ----------
  // 两种桌面壳（收起=小球，点击展开=面板）：
  //   pywebview / Electron：面板展开/收起时通知桌面壳调整窗口大小
  const isPywebview = typeof window.pywebview !== 'undefined' && !!window.pywebview?.api;
  const isElectron = !!window.desktopShell?.isElectron;
  const isDesktop = isPywebview || isElectron;

  function desktopSetSize(expanded) {
    // 锚点 = 悬浮球当前的屏幕中心：展开/收起时球在屏幕上不动
    const r = orb.getBoundingClientRect();
    const anchorX = Math.round(window.screenX + r.left + r.width / 2);
    const anchorY = Math.round(window.screenY + r.top + r.height / 2);
    if (isPywebview && window.pywebview.api.setSize) {
      window.pywebview.api.setSize(!!expanded);
    } else if (isElectron) {
      window.desktopShell.setSize(!!expanded, anchorX, anchorY);
    }
  }

  function desktopDragStart() {
    if (isPywebview && window.pywebview.api.dragStart) {
      window.pywebview.api.dragStart();
    } else if (isElectron) {
      window.desktopShell.dragStart();
    }
  }

  function desktopDragMove(dx, dy) {
    if (isPywebview && window.pywebview.api.drag) {
      window.pywebview.api.drag(Math.round(dx), Math.round(dy));
    } else if (isElectron) {
      window.desktopShell.dragMove(Math.round(dx), Math.round(dy));
    }
  }

  // ============ 基础 RPC ============
  async function rpc(method, payload) {
    const rpcId = crypto.randomUUID();
    const body = { type: 'client-request', rpcId, method, payload };
    const res = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.result.ok) {
      const err = data.result.error || {};
      throw new Error(`${err.code || 'error'}: ${err.message || JSON.stringify(err)}`);
    }
    return data.result.value;
  }

  // ============ 配置读写（config.json） ============
  async function loadConfig() {
    const res = await fetch('/api/widget-config');
    if (res.ok) {
      try { config = await res.json(); } catch { config = {}; }
    }
    return config;
  }

  async function saveConfig() {
    await fetch('/api/widget-config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    });
  }

  // ============ 文本提取 ============
  function extractText(blocks) {
    if (!Array.isArray(blocks)) return '';
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  }

  /** 是否为真实用户消息（DSH 会把系统提示等注入成 user/message，source.kind 为 plugin，要滤掉） */
  function isRealUserMessage(ev) {
    return ev.type === 'user/message' && ev.data?.source?.kind === 'user';
  }

  // ============ 渲染 ============
  function addMessage(role, text) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function addSys(text, cls = 'sys') {
    const el = document.createElement('div');
    el.className = `msg ${cls}`;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function addBindItem(text, sub, onClick) {
    const el = document.createElement('button');
    el.className = 'bind-item';
    el.innerHTML = `<span class="bind-title"></span><span class="bind-sub"></span>`;
    el.querySelector('.bind-title').textContent = text;
    if (sub) el.querySelector('.bind-sub').textContent = sub;
    el.addEventListener('click', onClick);
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function clearMessages() {
    messagesEl.innerHTML = '';
    streamingEl = null;
  }

  function startStreaming() {
    if (streamingEl) return streamingEl;
    streamingEl = document.createElement('div');
    streamingEl.className = 'msg ai';
    const caret = document.createElement('span');
    caret.className = 'caret';
    streamingEl.appendChild(caret);
    messagesEl.appendChild(streamingEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return streamingEl;
  }

  function appendStreamText(text) {
    const el = startStreaming();
    const caret = el.querySelector('.caret');
    el.insertBefore(document.createTextNode(text), caret);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function finishStreaming(fullText) {
    if (!streamingEl) return;
    if (typeof fullText === 'string') {
      streamingEl.textContent = fullText; // 用权威的完整消息替换
    } else {
      streamingEl.querySelector('.caret')?.remove();
    }
    streamingEl = null;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setBusy(v) {
    busy = v;
    orb.classList.toggle('busy', v);
    sendBtn.disabled = v || !config.sessionId || bindMode;
    stopBtn.disabled = !v;
  }

  function setStatus(state, text) {
    statusEl.className = 'status ' + state;
    statusText.textContent = text;
  }

  // ============ 历史 ============
  async function loadHistory() {
    clearMessages();
    try {
      const { events } = await rpc('session.history', { sessionId: config.sessionId, maxMessages: 50 });
      for (const { event } of events) {
        if (isRealUserMessage(event)) {
          addMessage('user', extractText(event.data.content));
        } else if (event.type === 'assistant/message') {
          addMessage('ai', extractText(event.data.message.content));
        }
      }
    } catch (err) {
      addSys('历史记录读取失败：' + err.message, 'err');
    }
  }

  // ============ 绑定：选择工作区/对话 ============
  async function openBindPanel() {
    bindMode = true;
    desktopSetSize(true); // 桌面模式：绑定界面需要展开窗口
    setBusy(false);
    clearMessages();
    addSys('选择要绑定的工作区：');
    try {
      const { items } = await rpc('workspace.list', {});
      if (!items.length) {
        addSys('还没有任何工作区。请先在 DSH 网页里新建一个工作区和对话。', 'err');
        bindMode = false;
        return;
      }
      for (const ws of items) {
        addBindItem(`📁 ${ws.title}`, `${ws.path} · ${ws.sessionIds.length} 个对话`, () => showWorkspaceSessions(ws));
      }
    } catch (err) {
      addSys('读取工作区失败：' + err.message, 'err');
    } finally {
      bindMode = false;
    }
  }

  async function showWorkspaceSessions(ws) {
    bindMode = true;
    clearMessages();
    addSys(`工作区「${ws.title}」里的对话：`);
    const labels = await Promise.all(
      ws.sessionIds.slice(0, 12).map(async (sid) => {
        try {
          const { events } = await rpc('session.history', { sessionId: sid, maxMessages: 5 });
          for (const { event } of events) {
            if (isRealUserMessage(event)) {
              const t = extractText(event.data.content).replace(/\s+/g, ' ').trim();
              return { sid, label: t ? `💬 ${t.slice(0, 40)}` : '（空白对话）' };
            }
          }
          return { sid, label: '（空白对话）' };
        } catch {
          return { sid, label: `⚠ ${sid.slice(0, 20)}…` };
        }
      }),
    );
    for (const { sid, label } of labels) {
      addBindItem(label, sid, () => bindTo(sid, ws.workspaceId));
    }
    addBindItem('＋ 在此工作区新建对话', ws.title, async () => {
      try {
        const created = await rpc('session.create', { workspaceId: ws.workspaceId });
        await bindTo(created.sessionId, ws.workspaceId);
      } catch (err) {
        addSys('新建失败：' + err.message, 'err');
      }
    });
    bindMode = false;
  }

  async function bindTo(sessionId, workspaceId) {
    config = { workspaceId: workspaceId ?? null, sessionId };
    try {
      await saveConfig();
    } catch (err) {
      addSys('保存绑定失败（不影响本次使用）：' + err.message, 'err');
    }
    setStatus('online', '已连接');
    bindMode = false;
    setBusy(false);
    await loadHistory();
    connectMux();
  }

  // ============ 发消息 / 停止 ============
  async function send() {
    const text = inputEl.value.trim();
    if (!text || busy || !config.sessionId || bindMode) return;
    inputEl.value = '';
    autoGrow();
    setBusy(true);
    try {
      await rpc('session.prompt', {
        sessionId: config.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      // 用户气泡等 user/message 事件回来再渲染（保证和 DSH 记录一致）
    } catch (err) {
      setBusy(false);
      addSys('发送失败：' + err.message, 'err');
    }
  }

  async function stop() {
    try {
      await rpc('session.cancel', { sessionId: config.sessionId });
    } catch (err) {
      addSys('停止失败：' + err.message, 'err');
    }
  }

  // ============ 事件流（mux WebSocket） ============
  function handleFrame(msg) {
    const frame = msg.payload;
    if (!frame) return;
    switch (frame.type) {
      case 'session/event': {
        if (frame.sessionId !== config.sessionId) return;
        handleSessionEvent(frame.event);
        break;
      }
      case 'host/session-status': {
        if (frame.sessionId === config.sessionId) setBusy(frame.running);
        break;
      }
      default:
        break; // session/subscribed、approval/requested 等暂不处理
    }
  }

  function handleSessionEvent(ev) {
    switch (ev.type) {
      case 'turn/start':
        setBusy(true);
        break;

      case 'user/message': {
        if (!isRealUserMessage(ev)) return; // 滤掉注入的系统上下文
        const text = extractText(ev.data.content);
        if (text) addMessage('user', text);
        break;
      }

      case 'assistant/chunk': {
        const chunk = ev.data.chunk;
        if (chunk && chunk.type === 'text-delta' && chunk.text) {
          appendStreamText(chunk.text);
        }
        break;
      }

      case 'assistant/message': {
        finishStreaming(extractText(ev.data.message?.content));
        break;
      }

      case 'turn/end':
        finishStreaming();
        setBusy(false);
        break;

      default:
        break;
    }
  }

  async function connectMux() {
    if (muxWs || closing) return;
    const ws = new WebSocket(`ws://${location.host}/api/events.mux`);
    muxWs = ws;
    ws.onmessage = (e) => {
      try {
        handleFrame(JSON.parse(e.data));
      } catch (err) {
        console.warn('[mux] 帧解析失败', err);
      }
    };
    ws.onclose = () => {
      muxWs = null;
      if (!closing) setTimeout(connectMux, 2000); // 断线自动重连
    };
    ws.onerror = () => ws.close();
  }

  // ============ 初始化 ============
  async function init() {
    try {
      const desc = await rpc('host.describe', {});
      modelInfoEl.textContent = desc.model || '';

      const cfg = await loadConfig();
      if (cfg.sessionId) {
        try {
          await rpc('session.history', { sessionId: cfg.sessionId, maxMessages: 1 });
          config = cfg;
          setStatus('online', '已连接');
          await loadHistory();
          connectMux();
          return;
        } catch {
          config = { workspaceId: null, sessionId: null }; // 绑定失效，重新选
        }
      }
      // 未绑定 → 引导选择
      setStatus('offline', '未绑定对话');
      openBindPanel();
    } catch (err) {
      setStatus('offline', 'DSH 未连接，重试中…');
      setTimeout(init, 5000); // DSH 重启后自动恢复
    }
  }

  // ============ 悬浮球拖动 ============
  let dragState = null;
  let dragRafPending = false;

  function orbCenter() {
    const r = orb.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function layoutOrb(x, y) {
    const pad = 10;
    x = Math.max(pad, Math.min(innerWidth - pad, x));
    y = Math.max(pad, Math.min(innerHeight - pad, y));
    orb.style.left = x + 'px';
    orb.style.top = y + 'px';
    orb.style.transform = 'translate(-50%, -50%)';
    // 面板放在悬浮球左侧：面板右边缘 = 球左边缘 - 16px 间距（即面板左边缘 = 球心 - 44 - 面板宽）；
    // 屏幕左边放不下就翻到右侧。
    const pw = panel.offsetWidth || 380;
    const leftSide = x - 44 - pw;
    panel.style.left = (leftSide >= pad ? leftSide : x + 44) + 'px';
    panel.style.top = y + 'px';
  }

  orb.addEventListener('pointerdown', (e) => {
    // 用屏幕绝对坐标（screenX）记录起点：
    // 拖动时窗口本身在动，clientX 会跟着窗口变，形成反馈环导致抖动
    dragState = { sx: e.screenX, sy: e.screenY, ox: orbCenter().x, oy: orbCenter().y, moved: false };
    orb.setPointerCapture(e.pointerId);
    orb.classList.add('dragging');
    if (isDesktop) desktopDragStart(); // 记录窗口锚点
  });
  orb.addEventListener('pointermove', (e) => {
    if (!dragState) return;
    const dx = e.screenX - dragState.sx;
    const dy = e.screenY - dragState.sy;
    // 6px 阈值：点击时手抖一下不会误判成拖动
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) dragState.moved = true;
    if (!dragState.moved) return;
    if (isDesktop) {
      // 拖动 IPC 按帧节流，避免高频调用；传「总位移」，主进程绝对定位
      if (dragRafPending) return;
      dragRafPending = true;
      requestAnimationFrame(() => {
        dragRafPending = false;
        desktopDragMove(dx, dy);
      });
    } else {
      layoutOrb(dragState.ox + dx, dragState.oy + dy);
    }
  });
  orb.addEventListener('pointerup', (e) => {
    if (!dragState) return;
    const wasDrag = dragState.moved;
    dragState = null;
    orb.classList.remove('dragging');
    if (!wasDrag) togglePanel();
  });
  orb.addEventListener('pointercancel', () => {
    dragState = null;
    orb.classList.remove('dragging');
  });
  // 右键悬浮球 = 退出（桌面版），同时禁用浏览器默认菜单
  orb.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (isElectron) window.desktopShell.quit();
  });

  function togglePanel(force) {
    const show = force !== undefined ? force : panel.classList.contains('hidden');
    if (show) {
      const c = orbCenter();
      layoutOrb(c.x, c.y);
      panel.classList.remove('hidden');
      inputEl.focus();
    } else {
      panel.classList.add('hidden');
    }
    desktopSetSize(show); // 桌面模式：通知 Python 展开/收起窗口
  }

  // ============ 输入 ============
  function autoGrow() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }
  inputEl.addEventListener('input', autoGrow);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape' && !panel.classList.contains('hidden')) {
      panel.classList.add('hidden');
      desktopSetSize(false); // 桌面模式收起窗口
    }
  });
  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', stop);
  bindBtn.addEventListener('click', () => { togglePanel(true); openBindPanel(); });
  document.getElementById('btn-close').addEventListener('click', () => togglePanel(false)); // 收起面板 + 通知桌面壳收起窗口

  // 悬浮球摆位：永远贴在窗口右缘（innerWidth - 46）。
  // 收起/展开时右缘被主进程锚定，窗口缩放过程中球不会动。
  function placeOrbForViewport() {
    layoutOrb(innerWidth - 46, innerHeight / 2);
  }

  // 起始位置
  placeOrbForViewport();

  // 窗口尺寸变化时（桌面模式展开/收起），重新摆位悬浮球；
  // 拖动过程中不重摆，避免和窗口移动互相干扰
  window.addEventListener('resize', () => {
    if (isDesktop && !dragState) placeOrbForViewport();
  });

  // Electron 点击穿透：鼠标在悬浮球/面板上 → 恢复交互；移开 → 穿透给下层应用。
  // 只在状态真正变化时才发 IPC（防抖），拖动中锁定不切换。
  if (isElectron) {
    let lastInteractive = false;
    document.addEventListener('mousemove', (e) => {
      if (dragState) return; // 拖动中锁定
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const interactive = !!(el && el.closest && el.closest('#orb, #panel'));
      if (interactive === lastInteractive) return; // 状态没变，不发 IPC
      lastInteractive = interactive;
      window.desktopShell.setIgnoreMouse(!interactive);
    });
  }

  init();
})();
