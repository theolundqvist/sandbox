// Loaded into the game: the player's name, whether an update is out, a way to ask the app to install it, the agents it can start beside the game, and the way back to its title screen.
const { contextBridge, ipcRenderer } = require("electron");

// The app says so as the page loads, before the game has set up its menu, so the last word is kept for it.
let version = null;
const listeners = [];
ipcRenderer.on("update", (_, v) => {
  version = v;
  for (const fn of listeners) fn(v);
});
const progress = [];
ipcRenderer.on("updating", (_, p) => {
  for (const fn of progress) fn(p);
});

contextBridge.exposeInMainWorld("sandboxDesktop", {
  name: ipcRenderer.sendSync("player-name"),
  update: () => ipcRenderer.invoke("update"),
  agents: ipcRenderer.sendSync("agents"),
  build: (id, key) => ipcRenderer.invoke("build", id, key),
  leave: () => ipcRenderer.send("leave"),
  onUpdating: (fn) => progress.push(fn),
  onUpdate: (fn) => {
    listeners.push(fn);
    fn(version);
  },
});
