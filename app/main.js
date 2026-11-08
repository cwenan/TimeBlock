const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, powerMonitor, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let tray = null;
let quitting = false;
let balloonShown = false;
let appSettings = { trayOnClose: true, autoStart: false };
let lastOverlay = null; // 最近一次动态任务栏图标（dataURL），用于托盘恢复后重放

// 临时诊断日志：任务栏图标异常排查用（每次启动清空）
const dbg = (line) => {
  try { fs.appendFile(path.join(app.getPath('userData'), 'icon-debug.log'), `[${new Date().toISOString()}] ${line}\n`, () => {}); } catch (err) {}
};

// 便携版：记住用户双击的原始 exe 位置（自解压临时目录会被清理，不能用作开机自启路径）
const LAUNCH_PATH = process.env.PORTABLE_EXECUTABLE_PATH || process.execPath;

// 开机自启 = 在用户「启动」文件夹写入/删除快捷方式（透明、可手工增删）
const startupLnk = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', '时间块.lnk');
function applyAutoStart(on) {
  try {
    const lnk = startupLnk();
    if (on) {
      shell.writeShortcutLink(lnk, 'create', { target: LAUNCH_PATH, description: '时间块 开机自启' });
    } else if (fs.existsSync(lnk)) {
      fs.unlinkSync(lnk);
    }
  } catch (err) {}
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.whenReady().then(() => {
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'icon-debug.log'), ''); } catch (err) {}
    dbg('boot, packaged=' + app.isPackaged);
    win = new BrowserWindow({
      width: 940,
      height: 780,
      minWidth: 420,
      minHeight: 600,
      title: '时间块',
      backgroundColor: '#f7f2e9',
      icon: path.join(__dirname, 'build', 'icon.png'),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    Menu.setApplicationMenu(null);
    win.loadFile('index.html');

    const hideToTray = () => {
      win.hide();
      if (!balloonShown) {
        balloonShown = true;
        try {
          tray.displayBalloon({ title: '时间块仍在运行', content: '已缩小到系统托盘——点击托盘图标即可恢复窗口', type: 'info' });
        } catch (err) {}
      }
    };

    // 点 × 关闭 → 收进托盘（可在设置中关闭此行为）；最小化保持系统默认（任务栏）
    win.on('close', (e) => {
      if (!quitting && appSettings.trayOnClose) { e.preventDefault(); hideToTray(); }
    });

    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 }));
    tray.setToolTip('时间块');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 时间块', click: () => { win.show(); win.focus(); } },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', () => {
      if (!win.isVisible()) { win.show(); win.focus(); }
    });
    tray.on('double-click', () => { win.show(); win.focus(); });

    // 全局快捷键：按上次参数直接宣告一块
    globalShortcut.register('Ctrl+Alt+Space', () => {
      if (win) { win.show(); win.focus(); win.webContents.send('command', { type: 'hotkey-allocate' }); }
    });

    // 任务栏动态图标（进度条画在图标内，原生 setProgressBar 不再使用）
    // 任务栏原生进度条（用户指定保留底部这条）+ 动态图标
    ipcMain.on('progress', (e, { v, m } = {}) => {
      if (!win) return;
      try {
        if (v == null || v < 0) { win.setProgressBar(-1, { mode: 'none' }); }
        else { win.setProgressBar(Math.min(1, Math.max(0, v)), { mode: m === 'paused' ? 'paused' : 'normal' }); }
      } catch (err) {}
    });
    ipcMain.on('overlay', (e, payload) => {
      if (!win) return;
      try {
        if (!payload) {
          // 空闲：清掉任务栏角标
          lastOverlay = null;
          win.setOverlayIcon(null, '');
          dbg('overlay cleared (idle)');
          return;
        }
        // Windows 原生角标：setOverlayIcon 是系统提供的动态徽标通道，打包后依然生效；
        // 不再用 setIcon 改整个窗口图标（Electron 打包版不会刷新，数字会消失）
        lastOverlay = payload;
        applyOverlay(payload);
        dbg(`overlay applied: ${payload.label || ''}`);
      } catch (err) { dbg('overlay error: ' + err.message); }
    });
    const applyOverlay = (p) => {
      try {
        if (!win) return;
        const img = nativeImage.createFromDataURL(p.badge);
        win.setOverlayIcon(img, p.label || '');
      } catch (err) { dbg('applyOverlay error: ' + err.message); }
    };
    // 窗口从托盘/最小化恢复时任务栏按钮会重建，角标需要重放
    const reapplyOverlay = () => {
      if (lastOverlay) { applyOverlay(lastOverlay); dbg('overlay reapplied after show/restore'); }
    };
    win.on('show', reapplyOverlay);
    win.on('restore', reapplyOverlay);
    win.on('focus', reapplyOverlay);
    ipcMain.on('tray-tip', (e, text) => {
      try { if (tray && text) tray.setToolTip(text); } catch (err) {}
    });

    // 设置：开机自启（启动文件夹快捷方式，便携版/安装版通用、透明可查）+ 托盘行为
    ipcMain.on('settings', (e, s) => {
      const prev = appSettings.autoStart;
      appSettings = { ...appSettings, ...(s || {}) };
      if (app.isPackaged && prev !== !!appSettings.autoStart) applyAutoStart(!!appSettings.autoStart);
    });
    ipcMain.handle('get-login', () => {
      try {
        if (!app.isPackaged) return { openAtLogin: false };
        return { openAtLogin: fs.existsSync(startupLnk()) };
      } catch (err) { return { openAtLogin: false }; }
    });

    // 系统休眠：按已专注时长结算（PRD §10）
    powerMonitor.on('suspend', () => {
      if (win) win.webContents.send('command', { type: 'system-suspend' });
    });
    powerMonitor.on('resume', () => {
      if (win) win.webContents.send('command', { type: 'system-resume' });
    });

    win.on('closed', () => { win = null; });
  });

  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); });
  app.on('window-all-closed', () => { app.quit(); });
}
