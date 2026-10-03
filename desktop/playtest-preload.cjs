// The playtest's page believes it is shown and has the mouse locked, so the game plays as it does for a player, while the real mouse stays with the player.
let locked = null;
const announce = () => document.dispatchEvent(new Event("pointerlockchange"));
Object.defineProperty(Document.prototype, "pointerLockElement", { get: () => locked, configurable: true });
Element.prototype.requestPointerLock = function () {
  locked = this;
  setTimeout(announce);
  return Promise.resolve();
};
Document.prototype.exitPointerLock = function () {
  locked = null;
  setTimeout(announce);
};
Object.defineProperty(Document.prototype, "hidden", { get: () => false, configurable: true });
Object.defineProperty(Document.prototype, "visibilityState", { get: () => "visible", configurable: true });
// The playtest moves the mouse off the centre and back each look step; only the move away counts.
for (const type of ["pointermove", "mousemove"])
  addEventListener(type, (e) => locked && e.clientX === innerWidth / 2 && e.clientY === innerHeight / 2 && e.stopImmediatePropagation(), true);
