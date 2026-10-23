/**
 * 悬浮AI小助手 - Electron 主进程
 *
 * 做一个无边框、透明、置顶的悬浮窗，盖在任何应用上面：
 *   - 收起状态：64x64 的小悬浮球贴在屏幕右缘（几乎不挡任何东西）
 *   - 点击悬浮球：窗口展开成聊天面板（右缘保持不动）
 *   - 拖动悬浮球 = 拖动整个窗口
 *
 * 用法：
 *   npx electron .                      正常启动
 *   npx electron . --debug              带开发者工具
 *   DSH_SELFTEST=1 npx electron .       自动化自检后退出
 */
const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const WIDGET_URL = 'http://127.0.0.1:8787';
// 收起宽度要足够让 56px 的悬浮球完整贴在右缘（球心 = 宽 - 46）
const COLLAPSED_W = 84;
const COLLAPSED_H = 64;
const EXPANDED_W = 470;
const RIGHT_MARGIN = 12;
const DEBUG = process.argv.includes('--debug');

let serverProc = null;
let win = null;
let expanded = false; // 当前窗口状态，去重：避免重复 IPC 造成 64↔470 闪烁

// 用户数据放项目内（便携，也避免写入系统 AppData 被沙箱拦截）
app.setPath('userData', path.join(__dirname, '..', '.electron-user-data'));

function isServerUp() {
  return new Promise((resolve) => {
    const req = http.get(WIDGET_URL + '/', { timeout: 1000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function spawnServer() {
  const nodeCmd = process.platform === 'win32' ? 'node.exe' : 'node';
  serverProc = spawn(nodeCmd, ['server.mjs'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  });
}

async function waitServerUp(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const x = workArea.x + workArea.width - RIGHT_MARGIN - COLLAPSED_W;
  const y = workArea.y + Math.max(10, (workArea.height - COLLAPSED_H) / 2);

  win = new BrowserWindow({
    width: COLLAPSED_W,
    height: COLLAPSED_H,
    x,
    y,
    useContentSize: true,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 悬浮窗：保持高于普通窗口（screen-saver 层级）
  win.setAlwaysOnTop(true, 'screen-saver');

  // 默认点击穿透：透明区域不挡下层应用（鼠标移到悬浮球/面板上会自动恢复交互）
  win.setIgnoreMouseEvents(true, { forward: true });

  // 自愈：页面加载失败（本地服务崩了/没起来）→ 重启服务并重新加载，
  // 避免悬浮窗变成透明空盒子找不到
  win.webContents.on('did-fail-load', async (_e, code, desc) => {
    console.error('[main] 页面加载失败:', code, desc, '→ 重启本地服务');
    if (!(await isServerUp())) {
      if (serverProc) { try { serverProc.kill(); } catch {} serverProc = null; }
      spawnServer();
      await waitServerUp(10000);
    }
    try { win.webContents.reload(); } catch { /* 忽略 */ }
  });

  win.loadURL(WIDGET_URL);

  if (DEBUG) win.webContents.openDevTools({ mode: 'detach' });

  win.on('closed', () => { win = null; });
}

function selftest() {
  setTimeout(async () => {
    try {
      const js = (code) => win.webContents.executeJavaScript(code).catch((e) => `ERR: ${e.message}`);

      // 1) 收起状态
      console.log('[selftest] collapsed:', win.getSize(), 'position:', win.getPosition());

      // 2) 拖拽锚点 + 绝对定位：重复同一总位移不应漂移（防“向右飞”回归）
      await js("window.desktopShell.dragStart()");
      await js("window.desktopShell.dragMove(30, 20)");
      await new Promise((r) => setTimeout(r, 400));
      const p1 = win.getPosition();
      await js("window.desktopShell.dragMove(30, 20)"); // 重复同一位移
      await new Promise((r) => setTimeout(r, 400));
      const p2 = win.getPosition();
      console.log('[selftest] drag idempotent: drift =', p2[0] - p1[0], p2[1] - p1[1], '(应为 0)');

      // 3) 真实鼠标点击悬浮球（pointer 事件流）→ 展开面板，悬浮球屏幕坐标不应跳动
      const orbMeasure = () => js(
        "(function(){const r=document.getElementById('orb').getBoundingClientRect();return {screenX: window.screenX, rect:[r.left,r.top], center:[window.screenX+r.left+r.width/2, window.screenY+r.top+r.height/2]};})()",
      );
      const before = await orbMeasure();
      console.log('[selftest] orb before:', JSON.stringify(before));
      const rect = await js(
        "(function(){const r=document.getElementById('orb').getBoundingClientRect();return [r.left+r.width/2, r.top+r.height/2];})()",
      );
      win.webContents.sendInputEvent({ type: 'mouseDown', x: rect[0], y: rect[1], button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: rect[0], y: rect[1], button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 1500));
      const after = await orbMeasure();
      console.log('[selftest] orb after :', JSON.stringify(after));
      console.log('[selftest] expanded:', win.getSize(), 'position:', win.getPosition());
      console.log('[selftest] orb moved on expand:', Math.round(after.center[0] - before.center[0]), Math.round(after.center[1] - before.center[1]), '(应接近 0)');
      const status = await js("document.getElementById('status-text').textContent");
      console.log('[selftest] status:', status);

      // 4) 发消息
      await js(
        "(function(){var i=document.getElementById('input');i.value='桌面悬浮窗自检，回我一句话';i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('btn-send').click();})();",
      );
      await new Promise((r) => setTimeout(r, 15000));
      const last = await js("(document.getElementById('messages').lastElementChild?.textContent||'').slice(0,140)");
      console.log('[selftest] last msg:', last);

      // 5) 收起面板（真实点击 ✕）→ 悬浮球屏幕坐标也不应跳动
      const before2 = await orbMeasure();
      await js("document.getElementById('btn-close').click()");
      await new Promise((r) => setTimeout(r, 1500));
      const after2 = await orbMeasure();
      console.log('[selftest] collapsed again:', win.getSize(), 'position:', win.getPosition());
      console.log('[selftest] orb moved on collapse:', Math.round(after2.center[0] - before2.center[0]), Math.round(after2.center[1] - before2.center[1]), '(应接近 0)');

      // 6) 快速连续开关（模拟手速快）→ 过期校正必须被丢弃，球不能乱跑
      const b3 = await orbMeasure();
      await js("window.desktopShell.setSize(true, 600, 400)");
      await js("window.desktopShell.setSize(false, 600, 400)");
      await js("window.desktopShell.setSize(true, 600, 400)");
      await new Promise((r) => setTimeout(r, 500));
      const m3 = await orbMeasure();
      await js("window.desktopShell.setSize(false, 600, 400)");
      await new Promise((r) => setTimeout(r, 500));
      const a3 = await orbMeasure();
      console.log('[selftest] rapid toggle: mid offset =', Math.round(m3.center[0] - 600), Math.round(m3.center[1] - 400), 'final offset =', Math.round(a3.center[0] - 600), Math.round(a3.center[1] - 400), '(应接近 0)');

      // 7) 点击穿透：鼠标移到悬浮球上 → 恢复交互；移到透明区 → 穿透
      const orbRect2 = await js(
        "(function(){const r=document.getElementById('orb').getBoundingClientRect();return [r.left+r.width/2, r.top+r.height/2];})()",
      );
      // 诊断：mousemove 是否触发、elementFromPoint 命中什么
      await js("window.__mmCount = 0; document.addEventListener('mousemove', function(){ window.__mmCount++; });");
      win.webContents.sendInputEvent({ type: 'mouseMove', x: orbRect2[0], y: orbRect2[1] });
      await new Promise((r) => setTimeout(r, 400));
      const diag = await js(
        "(function(){const r=document.getElementById('orb').getBoundingClientRect();const el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);return {mmCount: window.__mmCount, hit: el ? (el.id||el.className||el.tagName) : 'null'};})()",
      );
      console.log('[selftest] diag mousemove/hit:', JSON.stringify(diag));
      console.log('[selftest] click-through over orb:', mouseIgnored, '(应为 false = 可交互)');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 4, y: 4 }); // 透明区
      await new Promise((r) => setTimeout(r, 400));
      console.log('[selftest] click-through over empty:', mouseIgnored, '(应为 true = 穿透)');

      console.log('[selftest] DONE');
      app.exit(0);
    } catch (e) {
      console.error('[selftest] ERROR:', e);
      app.exit(1);
    }
  }, 5000);
}

app.whenReady().then(async () => {
  if (!(await isServerUp())) {
    spawnServer();
    if (!(await waitServerUp())) {
      console.error('本地服务启动失败，请确认 Node.js 可用。');
      app.exit(1);
      return;
    }
  }
  createWindow();
  if (process.env.DSH_SELFTEST) selftest();
});

let dragBase = null; // 拖动锚点：拖动开始时窗口的位置

// 拖动：拖动开始时记录锚点，之后每次用「锚点 + 总位移」绝对定位。
// 不能每帧把位移累加到当前坐标上——那会让窗口越拖越快（向右飞）。
ipcMain.on('drag-start', () => {
  dragBase = win ? win.getPosition() : null;
});

ipcMain.on('drag-move', (_e, dx, dy) => {
  if (!win || !dragBase) return;
  win.setPosition(dragBase[0] + dx, dragBase[1] + dy);
});

// 展开/收起：以「悬浮球的当前屏幕坐标」为锚点，窗口围绕锚点变形，
// 悬浮球在屏幕上纹丝不动（不会跳回屏幕右缘）。
// 锚点语义：展开时球在窗口右缘，收起时球在窗口中心，球心垂直居中。
// 展开/收起：以「悬浮球的当前屏幕坐标」为锚点。
// 悬浮球始终贴在窗口右缘（球心 = 窗口宽 - 46），主进程把窗口右缘锚定在
// 锚点 + 46，这样窗口缩放过程中右缘不动 → 悬浮球在屏幕上纹丝不动。
let resizeSeq = 0; // 操作序号：过期的尺寸校正直接丢弃，防快速点击时互相打架

ipcMain.on('set-size', (_e, exp, anchorX, anchorY) => {
  if (!!exp === expanded) return; // 去重
  expanded = !!exp;
  const seq = ++resizeSeq;
  const { workArea } = screen.getPrimaryDisplay();
  const w = expanded ? EXPANDED_W : COLLAPSED_W;
  const h = expanded ? Math.min(660, workArea.height - 60) : COLLAPSED_H;

  // 球心在窗口内的 x = 宽 - 46（收起/展开统一，避免缩放过程中定位规则切换导致乱跑）
  const orbInW = (rw) => rw - 46;
  const orbInH = (rh) => rh / 2;

  const clamp = (vx, vy, rw, rh) => ({
    x: Math.max(workArea.x + 10, Math.min(workArea.x + workArea.width - rw - 10, vx)),
    y: Math.max(workArea.y + 10, Math.min(workArea.y + workArea.height - rh - 10, vy)),
  });

  const apply = (vx, vy, rw, rh) => {
    const c = clamp(vx, vy, rw, rh);
    if (process.env.DSH_DEBUG && (c.x !== vx || c.y !== vy)) {
      console.log(`[debug]   clamp: (${vx},${vy}) -> (${c.x},${c.y})`);
    }
    win.setPosition(c.x, c.y);
  };

  // 阶段一：按「请求尺寸」立即摆位（Windows 上 setSize 异步生效，不能用真实尺寸）
  win.setSize(w, h);
  apply(anchorX - orbInW(w), anchorY - orbInH(h), w, h);

  // 阶段二：等缩放生效后，用真实尺寸把球精确钉回锚点（双次校正，带序号守卫）
  const settle = () => {
    if (!win || seq !== resizeSeq) return; // 已有更新的操作，丢弃这次校正
    const [rw, rh] = win.getSize();
    const x = Math.round(anchorX - orbInW(rw));
    const y = Math.round(anchorY - orbInH(rh));
    if (process.env.DSH_DEBUG) {
      console.log(`[debug]   settle exp=${exp} real=(${rw},${rh}) -> pos=(${x},${y})`);
    }
    apply(x, y, rw, rh);
  };
  setTimeout(settle, 100);
  setTimeout(settle, 300);
});

// 右键悬浮球 → 确认退出
ipcMain.on('quit-app', async () => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['退出', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: '悬浮AI小助手',
    message: '确定退出悬浮小助手吗？',
  });
  if (response === 0) app.quit();
});

// 点击穿透切换（页面检测到鼠标在悬浮球/面板上时恢复交互，移开再穿透）
let mouseIgnored = true;
ipcMain.on('set-ignore-mouse', (_e, ignore) => {
  mouseIgnored = !!ignore;
  if (!win) return;
  win.setIgnoreMouseEvents(mouseIgnored, { forward: true });
});

app.on('window-all-closed', () => {
  if (serverProc) { try { serverProc.kill(); } catch {} serverProc = null; }
  app.quit();
});
