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
// The playtest moves the mouse off the centre and back each look step. Only the move away counts, and as Chromium reports no movement for moves it didn't lock, the page gets each move's distance as its movement.
for (const type of ["pointermove", "mousemove"]) {
  let last = null;
  addEventListener(
    type,
    (e) => {
      const at = [e.clientX, e.clientY];
      const moved = last ? [at[0] - last[0], at[1] - last[1]] : [0, 0];
      last = at;
      if (!locked) return;
      if (at[0] === innerWidth / 2 && at[1] === innerHeight / 2) return e.stopImmediatePropagation();
      Object.defineProperties(e, { movementX: { value: moved[0] }, movementY: { value: moved[1] } });
    },
    true,
  );
}
