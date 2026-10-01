// Loaded only into the agent's terminal pane: what the agent prints, what the player types, the pane's size, and Stop.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agent", {
  name: ipcRenderer.sendSync("agent-name"),
  input: (data) => ipcRenderer.send("agent-input", data),
  resize: (cols, rows) => ipcRenderer.send("agent-resize", cols, rows),
  close: () => ipcRenderer.send("agent-close"),
  onOutput: (fn) => ipcRenderer.on("agent-output", (_, data) => fn(data)),
  onExit: (fn) => ipcRenderer.on("agent-exit", () => fn()),
});
