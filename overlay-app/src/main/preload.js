
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whipHost', {
  isElectron: true,

  onConfig: (cb) => ipcRenderer.on('config', (_e, config) => cb(config)),
  onSpawn: (cb) => ipcRenderer.on('spawn-whip', (_e, at) => cb(at)),
  onDrop: (cb) => ipcRenderer.on('drop-whip', () => cb()),
  onVerdict: (cb) => ipcRenderer.on('verdict', (_e, result) => cb(result)),
  onBridgeStatus: (cb) => ipcRenderer.on('bridge-status', (_e, status) => cb(status)),

  crack: (payload) => ipcRenderer.send('whip:crack', payload),
  alive: () => ipcRenderer.send('whip:alive'),
  whipGone: () => ipcRenderer.send('whip:gone'),

  getConfig: () => ipcRenderer.invoke('config:get'),
  getBridgeStatus: () => ipcRenderer.invoke('bridge:status'),
  copyPairingCode: () => ipcRenderer.invoke('pairing:copy')
});
