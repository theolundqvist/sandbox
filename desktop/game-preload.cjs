// Loaded into the game: the player's name, whether an update is out, a way to ask the app to install it, the agents it can start beside the game, publishing the hosted world through the app's account, the token that lets this player accept credit for building a world, who may join the world it hosts, keeping a joined world's picture, and the way back to its title screen.
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
  cover: (jpeg) => ipcRenderer.send("cover", jpeg),
  publish: (id) => ipcRenderer.invoke("publish", id),
  unpublish: (id) => ipcRenderer.invoke("unpublish", id),
  credit: (token) => ipcRenderer.send("credit-token", token),
  access: (id, mode, password) => ipcRenderer.invoke("access", id, mode, password),
  onUpdate: (fn) => {
    listeners.push(fn);
    fn(version);
  },
});
