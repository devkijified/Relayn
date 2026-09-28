const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const WebSocket = require('ws');

let win;
let ws;
const SERVER = process.env.RELAYN_SERVER || 'ws://localhost:8787/ws';

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

function connect() {
  ws = new WebSocket(SERVER);
  ws.on('open', () => win?.webContents.send('socket-status', 'connected'));
  ws.on('close', () => win?.webContents.send('socket-status', 'disconnected'));
  ws.on('error', error => win?.webContents.send('socket-error', error.message));
  ws.on('message', data => {
    try { win?.webContents.send('server-message', JSON.parse(String(data))); }
    catch { /* ignore malformed server payload */ }
  });
}

ipcMain.on('send-server', (_event, message) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
});

app.whenReady().then(() => { createWindow(); connect(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
