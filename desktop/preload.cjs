// Loaded only into the launch screen and title bar, never into the game.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shell", {
  platform: process.platform,
  state: () => ipcRenderer.invoke("state"),
  open: (url) => ipcRenderer.invoke("open", url),
  forget: (url) => ipcRenderer.invoke("forget", url),
  name: () => ipcRenderer.invoke("name"),
  setName: (name) => ipcRenderer.invoke("set-name", name),
  account: (action, body) => ipcRenderer.invoke("account", action, body),
  community: (action, body) => ipcRenderer.invoke("community", action, body),
  leave: () => ipcRenderer.send("leave"),
  quit: () => ipcRenderer.send("quit"),
  update: () => ipcRenderer.invoke("update"),
  version: () => ipcRenderer.invoke("version"),
  ready: () => ipcRenderer.invoke("ready"),
  events: (list) => ipcRenderer.send("events", list),
  shareUsage: (on) => ipcRenderer.invoke("share-usage", on),
  on: (channel, fn) => ["mode", "down", "update", "starting"].includes(channel) && ipcRenderer.on(channel, (_, value) => fn(value)),
});
