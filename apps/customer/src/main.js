const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const WebSocket = require('ws');

let win;
let ws;
const SERVER = process.env.SUPPORT_SERVER || 'ws://localhost:8787/ws';

function createWindow() {
  win = new BrowserWindow({ width: 980, height: 720, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.loadFile(path.join(__dirname, 'index.html'));
}
function connect() {
  ws = new WebSocket(SERVER);
  ws.on('message', data => win?.webContents.send('server-message', JSON.parse(String(data))));
  ws.on('open', () => win?.webContents.send('socket-status', 'connected'));
  ws.on('close', () => win?.webContents.send('socket-status', 'disconnected'));
}
ipcMain.on('send-server', (_e, msg) => ws?.send(JSON.stringify(msg)));
app.whenReady().then(() => { createWindow(); connect(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
