// Loaded into the game: the player's name, whether an update is out, a way to ask the app to install it, the agents it can start beside the game, and the way back to its title screen.
const { contextBridge, ipcRenderer } = require("electron");

// The app says so as the page loads, before the game has set up its menu, so the last word is kept for it.
let version = null;
const listeners = [];
ipcRenderer.on("update", (_, v) => {
  version = v;
  for (const fn of listeners) fn(v);
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
  onUpdate: (fn) => {
    listeners.push(fn);
    fn(version);
  },
});
