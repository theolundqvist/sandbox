// Loaded only into the launch screen and title bar, never into the game.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shell", {
  platform: process.platform,
  state: () => ipcRenderer.invoke("state"),
  open: (url) => ipcRenderer.invoke("open", url),
  forget: (url) => ipcRenderer.invoke("forget", url),
  leave: () => ipcRenderer.send("leave"),
  quit: () => ipcRenderer.send("quit"),
  on: (channel, fn) => ["mode", "down"].includes(channel) && ipcRenderer.on(channel, (_, value) => fn(value)),
});
