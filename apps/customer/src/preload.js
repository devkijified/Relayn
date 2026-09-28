const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('support', {
  send: message => ipcRenderer.send('send-server', message),
  onMessage: callback => ipcRenderer.on('server-message', (_e, message) => callback(message)),
  onSocketStatus: callback => ipcRenderer.on('socket-status', (_e, status) => callback(status))
});
