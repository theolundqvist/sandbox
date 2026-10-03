// Loaded into the game: the player's name, whether an update is out and how its download goes, a way to ask the app to install it, the agents it can start beside the game, publishing the hosted world or one of its mods through the app's account, the token that lets this player accept credit for building a world, who may join the world it hosts, keeping a joined world's picture, and the way back to its title screen.
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
const leaveListeners = [];
// The app's Leave asks the game first, so the host's last view goes through their controls; a page that never asked to be told, like a world on an older version, leaves at once.
ipcRenderer.on("request-leave", () => {
  if (!leaveListeners.length) return ipcRenderer.send("leave");
  for (const fn of leaveListeners) fn();
});

contextBridge.exposeInMainWorld("sandboxDesktop", {
  name: ipcRenderer.sendSync("player-name"),
  update: () => ipcRenderer.invoke("update"),
  agents: ipcRenderer.sendSync("agents"),
  build: (id, key) => ipcRenderer.invoke("build", id, key),
  leave: () => ipcRenderer.send("leave"),
  onLeave: (fn) => leaveListeners.push(fn),
  onUpdating: (fn) => progress.push(fn),
  cover: (jpeg) => ipcRenderer.send("cover", jpeg),
  publish: (id) => ipcRenderer.invoke("publish", id),
  unpublish: (id) => ipcRenderer.invoke("unpublish", id),
  publishMod: (id, name) => ipcRenderer.invoke("publish-mod", id, name),
  credit: (token) => ipcRenderer.send("credit-token", token),
  access: (id, mode, password) => ipcRenderer.invoke("access", id, mode, password),
  onUpdate: (fn) => {
    listeners.push(fn);
    fn(version);
  },
});
