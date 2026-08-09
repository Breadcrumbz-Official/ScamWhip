
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scamwhip', {
  onStatus: (cb) => ipcRenderer.on('app:status', (_e, status) => cb(status)),

  getStatus: () => ipcRenderer.invoke('app:status'),
  copyPairingCode: () => ipcRenderer.invoke('app:copy-pairing'),

  spawnWhip: () => ipcRenderer.send('app:spawn'),
  forceHide: () => ipcRenderer.send('app:force-hide'),
  testCrack: () => ipcRenderer.send('app:test-crack'),
  openConfigFile: () => ipcRenderer.send('app:open-config-file'),
  openConfigFolder: () => ipcRenderer.send('app:open-config-folder'),
  hideWindow: () => ipcRenderer.send('app:hide-window'),
  quit: () => ipcRenderer.send('app:quit')
});
