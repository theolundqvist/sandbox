import type { ClientMod } from "../../api";

import type * as THREE from "three";

let lights: THREE.Light[] = [];
let yaw = 0;
let pitch = 0.45;
let distance = 14;
let sent = "";
let drag: { id: number; x: number; y: number } | null = null;

const onDown = (e: PointerEvent) => {
  if (e.button === 0 || e.button === 2) drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
};
const onUp = (e: PointerEvent) => {
  if (e.pointerId === drag?.id) drag = null;
};
const onMove = (e: PointerEvent) => {
  if (document.pointerLockElement) {
    yaw -= e.movementX * 0.003;
    pitch = Math.min(1.4, Math.max(0.05, pitch + e.movementY * 0.003));
    return;
  }
  if (e.pointerId !== drag?.id) return;
  yaw -= (e.clientX - drag.x) * 0.005;
  pitch = Math.min(1.4, Math.max(0.05, pitch + (e.clientY - drag.y) * 0.005));
  [drag.x, drag.y] = [e.clientX, e.clientY];
};
const onWheel = (e: WheelEvent) => (distance = Math.min(60, Math.max(4, distance * (1 + e.deltaY * 0.001))));
const noMenu = (e: Event) => e.preventDefault();

export default {
  init(ctx) {
    const { THREE, scene } = ctx;
    scene.background = new THREE.Color("#9fc7e8");
    scene.fog = new THREE.Fog("#9fc7e8", 60, 220);
    const sun = new THREE.DirectionalLight("#fff4e0", 2.2);
    sun.position.set(30, 50, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, far: 200 });
    lights = [new THREE.HemisphereLight("#ffffff", "#5b6b4a", 1.4), sun];
    scene.add(...lights);

    const canvas = ctx.renderer.domElement;
    canvas.addEventListener("pointerdown", onDown);
    addEventListener("pointerup", onUp);
    addEventListener("pointermove", onMove);
    canvas.addEventListener("wheel", onWheel, { passive: true });
    canvas.addEventListener("contextmenu", noMenu);
  },

  dispose(ctx) {
    ctx.scene.remove(...lights);
    ctx.scene.background = null;
    ctx.scene.fog = null;

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
