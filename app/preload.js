const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('timeblock', {
  progress: (v, m) => ipcRenderer.send('progress', { v, m }),
  overlay: (d) => ipcRenderer.send('overlay', d),
  trayTip: (t) => ipcRenderer.send('tray-tip', t),
  setSettings: (s) => ipcRenderer.send('settings', s),
  getLogin: () => ipcRenderer.invoke('get-login'),
  onCommand: (fn) => ipcRenderer.on('command', (e, cmd) => fn(cmd))
});
