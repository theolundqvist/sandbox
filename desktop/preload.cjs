// Loaded only into the launch screen and title bar, never into the game.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shell", {
  platform: process.platform,
  state: () => ipcRenderer.invoke("state"),
  open: (url) => ipcRenderer.invoke("open", url),
  forget: (url) => ipcRenderer.invoke("forget", url),
  name: () => ipcRenderer.invoke("name"),
  setName: (name) => ipcRenderer.invoke("set-name", name),
  leave: () => ipcRenderer.send("leave"),
  quit: () => ipcRenderer.send("quit"),
  update: () => ipcRenderer.invoke("update"),
  ready: () => ipcRenderer.invoke("ready"),
  on: (channel, fn) => ["mode", "down", "update", "starting"].includes(channel) && ipcRenderer.on(channel, (_, value) => fn(value)),
});
