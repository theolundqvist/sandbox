// Loaded into the game: only whether an update is out, and a way to ask the app to install it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sandboxDesktop", {
  update: () => ipcRenderer.invoke("update"),
  onUpdate: (fn) => ipcRenderer.on("update", (_, version) => fn(version)),
});
