const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('relayn', {
  send: message => ipcRenderer.send('send-server', message),
  onMessage: callback => ipcRenderer.on('server-message', (_event, message) => callback(message)),
  onSocketStatus: callback => ipcRenderer.on('socket-status', (_event, status) => callback(status)),
  onSocketError: callback => ipcRenderer.on('socket-error', (_event, message) => callback(message))
});
