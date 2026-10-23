/**
 * 悬浮AI小助手 - preload
 * 把主进程能力安全地暴露给页面（contextIsolation 下用 contextBridge）。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopShell', {
  isElectron: true,
  /** 拖动开始：主进程记录窗口当前位置作为锚点 */
  dragStart: () => ipcRenderer.send('drag-start'),
  /** 拖动中：传「距起点的总位移」，主进程用锚点 + 总位移绝对定位 */
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', dx, dy),
  /** 面板展开/收起：以悬浮球当前屏幕坐标 (anchorX, anchorY) 为锚点调整窗口大小 */
  setSize: (expanded, anchorX, anchorY) => ipcRenderer.send('set-size', expanded, anchorX, anchorY),
  /** 点击穿透：true=透明区域不挡下层应用，false=恢复交互 */
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  /** 右键悬浮球：确认后退出应用 */
  quit: () => ipcRenderer.send('quit-app'),
});
