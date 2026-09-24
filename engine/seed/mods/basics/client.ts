import type { ClientMod } from "../../api";

let yaw = 0;
let pitch = 0.45;
let distance = 14;
let sent = "";
let dragging = false;

const onDown = (e: PointerEvent) => (dragging = e.button === 0 || e.button === 2);
const onUp = () => (dragging = false);
const onMove = (e: PointerEvent) => {
  if (!dragging) return;
  yaw -= e.movementX * 0.005;
  pitch = Math.min(1.4, Math.max(0.05, pitch + e.movementY * 0.005));
};
const onWheel = (e: WheelEvent) => (distance = Math.min(60, Math.max(4, distance * (1 + e.deltaY * 0.001))));
const noMenu = (e: Event) => e.preventDefault();

export default {
  init(ctx) {
    const canvas = ctx.renderer.domElement;
    canvas.addEventListener("pointerdown", onDown);
    addEventListener("pointerup", onUp);
    addEventListener("pointermove", onMove);
    canvas.addEventListener("wheel", onWheel, { passive: true });
    canvas.addEventListener("contextmenu", noMenu);
  },

  dispose(ctx) {
    const canvas = ctx.renderer.domElement;
    canvas.removeEventListener("pointerdown", onDown);
    removeEventListener("pointerup", onUp);
    removeEventListener("pointermove", onMove);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", noMenu);
  },

  frame(ctx) {
    const k = ctx.keys;
    const forward = +(k.has("KeyW") || k.has("ArrowUp")) - +(k.has("KeyS") || k.has("ArrowDown"));
    const right = +(k.has("KeyD") || k.has("ArrowRight")) - +(k.has("KeyA") || k.has("ArrowLeft"));
    const len = Math.hypot(forward, right) || 1;
    const x = (right * Math.cos(yaw) - forward * Math.sin(yaw)) / len;
    const z = (-right * Math.sin(yaw) - forward * Math.cos(yaw)) / len;
    const input = { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100, jump: k.has("Space") };
    const json = JSON.stringify(input);
    if (json !== sent) {
      ctx.send(input);
      sent = json;
    }

    const mine = [...ctx.entities].find(([, e]) => e.player === ctx.playerId);
    const target = mine && ctx.objects.get(mine[0]);
    if (!target) return;
    const { x: tx, y: ty, z: tz } = target.position;
    ctx.camera.position.set(tx + Math.sin(yaw) * Math.cos(pitch) * distance, ty + Math.sin(pitch) * distance, tz + Math.cos(yaw) * Math.cos(pitch) * distance);
    ctx.camera.lookAt(tx, ty + 1, tz);
  },
} satisfies ClientMod;
