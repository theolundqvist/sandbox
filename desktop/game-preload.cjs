// Loaded into the game: the player's name, whether an update is out, a way to ask the app to install it, and the way back to its title screen.
const { contextBridge, ipcRenderer } = require("electron");

// The app says so as the page loads, before the game has set up its menu, so the last word is kept for it.
let version = null;
const listeners = [];
ipcRenderer.on("update", (_, v) => {
  version = v;
  for (const fn of listeners) fn(v);
});

contextBridge.exposeInMainWorld("sandboxDesktop", {
  name: ipcRenderer.sendSync("player-name"),
  update: () => ipcRenderer.invoke("update"),
  leave: () => ipcRenderer.send("leave"),
  onUpdate: (fn) => {
    listeners.push(fn);
    fn(version);
  },
});
