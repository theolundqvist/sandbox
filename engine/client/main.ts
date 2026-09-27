import { toCanvas } from "html-to-image";
import * as THREE from "three";
import type { ClientCtx, ClientHooks, ClientMod, Entity, Game, ReplayShot } from "../api";
import { clock, extent, isAvatar, plan, position, type Activity, type Plan, type Tick as Moment, type Shot } from "./director";
import { PhysicsIndex, sizeOf } from "../physics";
import { mountPicker } from "./games";
import { phrases } from "./phrases";

/** The Tab menu, where players vote on mods, is in a closed shadow root only this file holds, so no mod can reach, hide or remove it; mods' blocks on its pages stay in the page, slotted in. Everything else on screen is the page's, for mods to restyle or remove. */
const ui = document.getElementById("ui")!;
const uiRoot = ui.attachShadow({ mode: "closed" });
uiRoot.adoptedStyleSheets = [...document.styleSheets].map((sheet) => {
  const copy = new CSSStyleSheet();
  copy.replaceSync([...sheet.cssRules].map((rule) => rule.cssText).join("\n"));
  return copy;
});
uiRoot.append(document.getElementById("menu")!);
const SHOWN = { display: "block", visibility: "visible", opacity: "1" };
/** Undoes whatever a mod does to #ui or to the page around it: puts it back in the page, drops its attributes, and keeps the page shown and usable. */
function keepUi() {
  if (ui.parentNode !== document.body) document.body.append(ui);
  for (const name of ui.getAttributeNames()) if (name !== "id" && name !== "class") ui.removeAttribute(name);
  if (ui.className !== document.body.className) ui.className = document.body.className;
  for (const el of [document.documentElement, document.body]) {
    el.inert = false;
    for (const [property, value] of Object.entries(SHOWN)) if (el.style.getPropertyValue(property) !== value || !el.style.getPropertyPriority(property)) el.style.setProperty(property, value, "important");
  }
}
keepUi();
const guard = new MutationObserver(keepUi);
guard.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "inert"] });
guard.observe(document.body, { childList: true, attributes: true, attributeFilter: ["style", "class", "inert"] });
guard.observe(ui, { attributes: true });
/** The engine's elements, held from the start, so one a mod removes only leaves the screen. */
const byId = new Map([...document.querySelectorAll<HTMLElement>("[id]"), ...uiRoot.querySelectorAll<HTMLElement>("[id]")].map((el) => [el.id, el]));
const $ = <T extends HTMLElement>(id: string) => (byId.get(id) ?? document.getElementById(id)) as T;
const all = <T extends Element>(selector: string) => [...document.querySelectorAll<T>(selector), ...uiRoot.querySelectorAll<T>(selector)];
/** The focused element, inside the menu too. */
const focused = () => uiRoot.activeElement ?? document.activeElement;
(await import(["/front.js"][0]!)).navigateIn(uiRoot);
const hashParams = new URLSearchParams(location.hash.slice(1));

// Through the relay the world lives at /r/<room>/; its own requests reach the room by cookie, but links and Claude need the full address.
const origin = location.origin + (location.pathname.match(/^\/r\/[a-z0-9-]+/)?.[0] ?? "");
const info = await (await fetch("/api/info")).json();
const keyName = `sandbox-key:${info.id}`;
/** The host watching the timelapse from the main menu, without joining: their world's host key. */
const watching = hashParams.get("watch");
if (watching) history.replaceState(null, "", location.pathname);
let key = watching ?? hashParams.get("key") ?? localStorage.getItem(keyName);
/** The host playing a world of theirs can reach its main menu; everyone shares the relay's address, so holding a key isn't enough. */
const hostKey = localStorage.getItem("sandbox-menu") ?? (await fetch("/api/local-key").then((r) => (r.ok ? r.json() : null)).then((r: { key: string } | null) => r?.key ?? null, () => null));
const hostMenu = (action: string, body?: object) => fetch(`/api/menu/${action}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${hostKey}` }, body: body && JSON.stringify(body) });
const hosting = hostKey ? await hostMenu("state").then((r) => (r.ok ? r.json() : null), () => null) : null;
let me = "";
let world = "";
let invite = "";
/** The world's one invite link from the host, which works only on the host's Wi-Fi while the relay can't be reached. */
let link: string | null = null;
let wifiOnly = false;

/** A name that belongs to an offline player waits for the host to let this computer in, for up to a minute. */
async function join(body: object) {
  const asking = "name" in body && setTimeout(() => {
    $("join-world").textContent = info.name;
    $("join-error").textContent = "Asking the host…";
    $("join-form").classList.add("asking");
    $("join").hidden = false;
  }, 500);
  const res = await fetch("/api/join", { method: "POST", body: JSON.stringify({ ...body, host: hosting?.running?.hostKey }) }).finally(() => {
    if (asking) clearTimeout(asking);
    $("join-form").classList.remove("asking");
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error), { password: !!data.password });
  localStorage.setItem(keyName, data.key);
  localStorage.setItem("sandbox-name", data.name);
  key = data.key;
  me = data.name;
  history.replaceState(null, "", location.pathname);
}

/** The join screen, over the game itself when the link holds an invite. A player who left the world comes back to it and rejoins as themselves. */
async function start() {
  const left = hashParams.has("left") && !!key;
  if (key && !left) {
    try {
      return await join({ key });
    } catch {
      localStorage.removeItem(keyName);
      key = null;
    }
  }
  const invited = hashParams.get("invite");
  // The desktop app joins as the player's name without asking; a world with a password asks for it once.
  const appName = (window as { sandboxDesktop?: { name: string | null } }).sandboxDesktop?.name;
  let refused = "";
  if (!left && invited && appName)
    try {
      return await join({ invite: invited, name: appName });
    } catch (err: any) {
      refused = err.password ? "" : err.message;
    }
  $("join-password-field").hidden = left || !info.password;
  $("join-error").textContent = refused;
  $("join-world").textContent = info.name;
  $("join-online").textContent = info.online ? `${info.online} playing` : "";
  $("join").hidden = false;
  $("join-name-field").hidden = left;
  if (hashParams.get("invite")) spectate(hashParams.get("invite")!);
  else if (!left) $("join-error").textContent = "Ask the host for an invite link.";
  const name = $<HTMLInputElement>("join-name");
  name.value = appName ?? localStorage.getItem("sandbox-name") ?? "";
  const named = () => ($<HTMLButtonElement>("join-go").disabled = !left && !name.value.trim());
  name.oninput = named;
  named();
  (left ? $("join-go") : name).focus();
  await new Promise<void>((resolve) => {
    $("join-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await join(left ? { key } : { invite: invited, name: name.value, password: $<HTMLInputElement>("join-password").value });
        $("join").hidden = true;
        resolve();
      } catch (err: any) {
        $("join-error").textContent = err.message;
      }
    };
  });
}

// ---------- scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.info.autoReset = false;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
camera.position.set(0, 10, 16);
camera.lookAt(0, 0, 0);

const listener = new THREE.AudioListener();
camera.add(listener);
const audio = { context: listener.context, listener, output: listener.getInput() };
for (const type of ["pointerdown", "keydown"]) addEventListener(type, () => !spectator && audio.context.state === "suspended" && void audio.context.resume(), true);

/** Every mod's shakes add up into one camera offset, applied for the draw only. */
const shakes: { strength: number; seconds: number; left: number }[] = [];
const shakeOffset = new THREE.Vector3();
function shakeCamera(dt: number) {
  shakeOffset.set(0, 0, 0);
  for (const s of shakes) {
    const k = (s.strength * s.left) / s.seconds;
    shakeOffset.x += (Math.random() * 2 - 1) * k;
    shakeOffset.y += (Math.random() * 2 - 1) * k;
    shakeOffset.z += (Math.random() * 2 - 1) * k;
    s.left -= dt;
  }
  for (let i = shakes.length - 1; i >= 0; i--) if (shakes[i]!.left <= 0) shakes.splice(i, 1);
  view.position.add(shakeOffset);
}

/** How the game is shown and controlled: every mod's ctx.screen settings merged, the highest order winning per field. */
type Screen = Parameters<ClientCtx["screen"]>[0];
let screen: Screen = {};
let view: THREE.Camera = camera;
function applyScreen() {
  const last = screen;
  screen = {};
  for (const m of ordered) for (const [k, v] of Object.entries(m.screen)) if (v !== undefined) (screen as any)[k] = v;
  if (view !== (screen.camera ?? camera)) {
    view = screen.camera ?? camera;
    view.add(listener);
    fit(view);
  }
  if (screen.resolution !== last.resolution) renderer.setPixelRatio(screen.resolution ?? Math.min(devicePixelRatio, 2));
  renderer.domElement.style.imageRendering = screen.pixelated ? "pixelated" : "";
  renderer.domElement.hidden = screen.scene === false;
  if (!screen.lockPointer && document.pointerLockElement) document.exitPointerLock();
}

/** Perspective cameras take the window's shape; orthographic ones keep their height and centre and widen to it. */
function fit(c: THREE.Camera) {
  const aspect = document.body.clientWidth / document.body.clientHeight;
  if (c instanceof THREE.PerspectiveCamera) c.aspect = aspect;
  else if (c instanceof THREE.OrthographicCamera) {
    const mid = (c.left + c.right) / 2;
    const half = ((c.top - c.bottom) / 2) * aspect;
    [c.left, c.right] = [mid - half, mid + half];
  } else return;
  c.updateProjectionMatrix();
}
function resize() {
  renderer.setSize(document.body.clientWidth, document.body.clientHeight);
  fit(camera);
  if (view !== camera) fit(view);
}
addEventListener("resize", resize);
resize();

// ---------- entities ----------
const entities = new Map<number, Entity>();
const objects = new Map<number, THREE.Object3D>();
const looks = new Map<number, string>();
/** Objects a mod's object hook made, by that mod. */
const claimed = new Map<THREE.Object3D, Loaded>();
/** The mod that made each solid entity nothing draws. */
const makers = new Map<number, string>();
const physics = new PhysicsIndex();

const geometries = new Map<string, { geometry: THREE.BufferGeometry; users: number }>();

function sharedGeometry(shape: string, size: number[]) {
  const key = JSON.stringify([shape, size]);
  const entry = geometries.get(key) ?? { geometry: geometry(shape, size), users: 0 };
  geometries.set(key, entry);
  entry.users++;
  entry.geometry.userData.key = key;
  return entry.geometry;
}

const materials = new Map<string, { material: THREE.Material; users: number }>();

function sharedMaterial(key: string, make: () => THREE.Material) {
  const entry = materials.get(key) ?? { material: make(), users: 0 };
  materials.set(key, entry);
  entry.users++;
  entry.material.userData.key = key;
  return entry.material;
}

function releaseMaterial(m: THREE.Material & { map?: THREE.Texture | null }) {
  const entry = materials.get(m.userData.key);
  if (entry?.material === m && --entry.users > 0) return;
  if (entry?.material === m) materials.delete(m.userData.key);
  m.map?.dispose();
  m.dispose();
}

function releaseGeometry(g: THREE.BufferGeometry) {
  const entry = geometries.get(g.userData.key);
  if (!entry || entry.geometry !== g) return g.dispose();
  if (--entry.users > 0) return;
  geometries.delete(g.userData.key);
  g.dispose();
}

function geometry(shape: string, size: number[]) {
  const [x = 1, y = x, z = x] = size;
  switch (shape) {
    case "sphere":
      return new THREE.SphereGeometry(x / 2, 32, 16);
    case "cylinder":
      return new THREE.CylinderGeometry(x / 2, x / 2, y, 24);
    case "cone":
      return new THREE.ConeGeometry(x / 2, y, 24);
    case "plane":
      return new THREE.BoxGeometry(x, 0.001, z ?? y);
    case "edges":
      return new THREE.EdgesGeometry(new THREE.BoxGeometry(x, y, z));
    default:
      return new THREE.BoxGeometry(x, y, z);
  }
}

function labelMaterial(text: string) {
  const canvas = document.createElement("canvas");
  const g = canvas.getContext("2d")!;
  g.font = "600 44px Inter, system-ui, sans-serif";
  canvas.width = Math.ceil(g.measureText(text).width) + 40;
  canvas.height = 64;
  g.font = "600 44px Inter, system-ui, sans-serif";
  g.fillStyle = "rgba(10,14,20,.6)";
  g.beginPath();
  g.roundRect(0, 0, canvas.width, canvas.height, 32);
  g.fill();
  g.fillStyle = "#fff";
  g.textBaseline = "middle";
  g.fillText(text, 20, 34);
  return new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false });
}

function labelSprite(material: THREE.SpriteMaterial) {
  const sprite = new THREE.Sprite(material);
  sprite.scale.set((material.map!.image as HTMLCanvasElement).width / 128, 0.5, 1);
  sprite.renderOrder = 10;
  return sprite;
}
const sharedLabel = (text: string) => labelSprite(sharedMaterial(`label ${text}`, () => labelMaterial(text)) as THREE.SpriteMaterial);

function build(id: number, e: Entity) {
  for (const m of [...ordered].reverse()) {
    if (!m.mod.object) continue;
    const made: THREE.Object3D | null | undefined = call(m, "object", id, e);
    if (made) {
      claimed.set(made, m);
      made.userData.mod ??= m.name;
      return made;
    }
  }
  return defaultObject(id, e);
}

function defaultObject(id: number, e: Entity) {
  const group = new THREE.Group();
  group.userData.mod = "engine";
  const size = e.solid && !e.mesh && sizeOf(e);
  if (size) {
    const wall = new THREE.LineSegments(sharedGeometry("edges", size), sharedMaterial("wall", () => new THREE.LineBasicMaterial({ color: "#ff9a2e", transparent: true, opacity: 0.7 })));
    group.add(wall);
    const maker = makers.get(id);
    group.userData.wall = maker ?? "unknown";
    const sprite = sharedLabel(maker ? `${maker}'s invisible wall` : "invisible wall");
    sprite.position.y = size[1] / 2 + 0.6;
    group.add(sprite);
  }
  if (e.mesh && e.mesh.opacity !== 0) {
    const size = typeof e.mesh.size === "number" ? [e.mesh.size] : (e.mesh.size ?? [1]);
    const look = { color: e.mesh.color ?? "#cccccc", emissive: e.mesh.emissive ?? "#000000", roughness: e.mesh.roughness ?? 0.8, metalness: e.mesh.metalness ?? 0, transparent: e.mesh.opacity !== undefined, opacity: e.mesh.opacity ?? 1 };
    const material = sharedMaterial(JSON.stringify(look), () => new THREE.MeshStandardMaterial(look));
    const mesh = new THREE.Mesh(sharedGeometry(e.mesh.shape ?? "box", size), material);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (e.label) {
    const sprite = sharedLabel(String(e.label));
    const height = Array.isArray(e.mesh?.size) ? (e.mesh.size[1] ?? 1) : (e.mesh?.size ?? 1);
    sprite.position.y = height / 2 + 0.6;
    group.add(sprite);
  }
  return group;
}

// Objects from a mod's object hook may share geometry and materials, so only the mod may free them.
function dispose(obj: THREE.Object3D) {
  scene.remove(obj);
  if (claimed.delete(obj)) return;
  obj.traverse((o: any) => {
    if (o.geometry) releaseGeometry(o.geometry);
    if (o.material) releaseMaterial(o.material);
  });
}

function syncObject(id: number, e: Entity | undefined, snap: boolean) {
  const old = objects.get(id);
  if (!e || !e.pos) {
    if (old) dispose(old);
    objects.delete(id);
    looks.delete(id);
    return;
  }
  const look = JSON.stringify([e.mesh, e.label, e.look, e.solid]);
  let obj = old;
  if (!obj || looks.get(id) !== look) {
    if (old) dispose(old);
    obj = build(id, e);
    obj.position.fromArray(e.pos);
    scene.add(obj);
    objects.set(id, obj);
    looks.set(id, look);
  }
  if (snap) obj.position.fromArray(e.pos);
}

/** After a mod starts or changes while the world loads: the entities its old version drew are built again, and it takes over those it outranks the drawer of. */
function reclaim(name: string) {
  const m = mods.get(name);
  const rank = m ? ordered.indexOf(m) : -1;
  for (const [id, obj] of objects) {
    const owner = claimed.get(obj);
    if (owner?.name === name && owner !== m) {
      looks.delete(id);
      syncObject(id, entities.get(id), true);
      continue;
    }
    if (!m?.mod.object || (owner && ordered.indexOf(owner) >= rank)) continue;
    const made: THREE.Object3D | null | undefined = call(m, "object", id, entities.get(id));
    if (!made) continue;
    dispose(obj);
    claimed.set(made, m);
    made.userData.mod ??= m.name;
    made.position.copy(obj.position);
    scene.add(made);
    objects.set(id, made);
  }
}

function rebuildAll() {
  for (const [id, e] of entities) {
    looks.delete(id);
    syncObject(id, e, true);
  }
}

/** Wireframes of the solid boxes near the camera: red where nothing is drawn, so an invisible wall shows up. */
let colliders: THREE.Group | null = null;
let collidersAt = 0;
const unitBox = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const drawnLine = new THREE.LineBasicMaterial({ color: "#5dff8a" });
const hiddenLine = new THREE.LineBasicMaterial({ color: "#ff3b3b", depthTest: false });

function showColliders(on: boolean) {
  if (!on) colliders?.removeFromParent();
  colliders = on ? new THREE.Group() : null;
  if (colliders) scene.add(colliders);
  collidersAt = 0;
}

function drawn(obj: THREE.Object3D | undefined) {
  let seen = false;
  obj?.traverseVisible((o: any) => void (seen ||= !!o.isMesh && o.material?.opacity !== 0 && o.material?.visible !== false));
  return seen;
}

function updateColliders(now: number) {
  if (!colliders || now - collidersAt < 250) return;
  collidersAt = now;
  colliders.clear();
  const at = view.getWorldPosition(new THREE.Vector3());
  for (const b of physics.boxes(at.x, at.z, 60)) {
    const line = new THREE.LineSegments(unitBox, drawn(objects.get(b.id)) ? drawnLine : hiddenLine);
    line.position.set(b.x, b.y, b.z);
    line.rotation.y = b.yaw;
    line.scale.set(b.hx * 2, b.hy * 2, b.hz * 2);
    line.renderOrder = 20;
    colliders.add(line);
  }
}

type Tick = { reset?: true; set: Record<string, Entity>; unset: Record<string, string[]>; removed: number[]; events?: { from: string; name: string; data: any }[]; makers?: Record<string, string> };

function applyTick({ reset, set, unset, removed, events, makers: made }: Tick) {
  if (reset) for (const id of [...entities.keys()]) if (!(id in set)) removed.push(id);
  for (const [id, mod] of Object.entries(made ?? {})) makers.set(Number(id), mod);
  for (const [key, changes] of Object.entries(set)) {
    const id = Number(key);
    const e = reset ? changes : Object.assign(entities.get(id) ?? {}, changes);
    entities.set(id, e);
    syncObject(id, e, !!reset);
    physics.update(id, e);
  }
  for (const [key, gone] of Object.entries(unset)) {
    const e = entities.get(Number(key));
    if (!e) continue;
    for (const k of gone) delete e[k];
    syncObject(Number(key), e, false);
    physics.update(Number(key), e);
  }
  for (const id of removed) {
    entities.delete(id);
    makers.delete(id);
    syncObject(id, undefined, false);
    physics.update(id, undefined);
  }
  for (const ev of events ?? []) for (const m of ordered) if (m.mod.event) call(m, "event", ev.name, ev.data, ev.from);
}

// ---------- mods ----------
type Action = Parameters<ClientCtx["interact"]>[0];
type Ground = (x: number, z: number, fromY: number) => number | null;
/** `traces` are the page-wide listeners and intervals its hooks added, swept when it unloads for good. */
type Loaded = { name: string; url: string; mod: ClientMod; ctx: ClientCtx; errors: number; ms: number; owned: HTMLElement[]; actions: Set<Action>; grounds: Set<Ground>; screen: Screen; traces: Trace[] };
type Trace = { listener: [EventTarget, string, EventListenerOrEventListenerObject, (boolean | EventListenerOptions)?] } | { interval: number };
const mods = new Map<string, Loaded>();
let ordered: Loaded[] = [];
const keys = new Set<string>();
let socket: WebSocket | null = null;
const send = (msg: object) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(msg));
const warn = console.warn.bind(console);

/** Keys mods declare with ctx.key: the engine dispatches them, so they never fire while the player types or has a window open. */
type Binding = { mod: Loaded; code: string; label: string; down?: () => void; up?: () => void };
const ENGINE_OWNED = ["Tab", "Escape", "Enter", "KeyT", "KeyE"];
/** G opens the games picker, in a world that has games. */
const engineOwns = (code: string) => ENGINE_OWNED.includes(code) || (code === "KeyG" && gameList.length > 0);
let bindings: Binding[] = [];
const held = new Map<string, Binding>();
const keyLabel = (code: string) => code.replace(/^(Key|Digit)/, "");

function declareKey(mod: Loaded, code: string, label: string, run: Parameters<ClientCtx["key"]>[2], opts?: { hold?: boolean }) {
  if (engineOwns(code)) throw new Error(`${code} belongs to the engine; pick another key`);
  const b: Binding = typeof run === "function" ? { mod, code, label, down: () => run(true), up: opts?.hold ? () => run(false) : undefined } : { mod, code, label, down: run.down, up: run.up };
  const other = bindings.findLast((x) => x.code === code && x.mod.name !== mod.name);
  if (other) {
    const text = `${code} is declared by both ${other.mod.name} ("${other.label}") and ${mod.name} ("${label}"); only ${mod.name}'s runs. Pick a free key (status lists them).`;
    warn(text);
    for (const name of [other.mod.name, mod.name]) send({ t: "log", mod: name, level: "warn", text });
  }
  bindings.push(b);
  keysChanged(mod.name);
  return () => {
    bindings = bindings.filter((x) => x !== b);
    if (held.get(code) === b) held.delete(code);
    keysChanged(mod.name);
  };
}
/** The latest live binding for each key; while a panel is open, only its mod's. */
function activeBindings() {
  const seen = new Map<string, Binding>();
  for (const b of bindings.toReversed()) if (!seen.has(b.code) && !engineOwns(b.code) && mods.get(b.mod.name) === b.mod && (!panel || b.mod === panel.mod)) seen.set(b.code, b);
  return [...seen.values()];
}
function press(b: Binding, down: boolean) {
  const fn = down ? b.down : b.up;
  if (fn) guarded(b.mod, `key ${b.code}`, fn);
}
function releaseKeys() {
  for (const b of held.values()) press(b, false);
  held.clear();
}

let changedMods: Set<string> | null = null;
/** Tells the server each changed mod's declared keys, once per batch of changes, so status and reload reports list them. */
function keysChanged(mod: string) {
  // A timelapse's past builds declare keys that aren't live.
  if (replay) return;
  if (!changedMods) {
    changedMods = new Set();
    setTimeout(() => {
      const declared = Object.fromEntries([...changedMods!].map((name) => [name, bindings.filter((b) => b.mod.name === name).map((b) => ({ code: b.code, label: b.label }))]));
      send({ t: "keys", keys: declared });
      changedMods = null;
      showModKeys();
    });
  }
  changedMods.add(mod);
}
function showModKeys() {
  for (const list of all(".mod-keys"))
    list.replaceChildren(
      ...activeBindings().flatMap((b) => {
        const dt = document.createElement("dt");
        dt.append(Object.assign(document.createElement("span"), { textContent: keyLabel(b.code) }));
        return [dt, Object.assign(document.createElement("dd"), { textContent: `${b.label} (${b.mod.name})` })];
      }),
    );
}

/** One mod window at a time: it holds the mouse and the keyboard until Esc or close(). */
let panel: { mod: Loaded; el: HTMLElement; added: boolean; relock: boolean; onClose?: () => void } | null = null;
function openPanel(mod: Loaded, el: HTMLElement, onClose?: () => void) {
  const relock = panel ? panel.relock : !!document.pointerLockElement;
  closePanel(false);
  const p = { mod, el, added: !el.isConnected, relock, onClose };
  if (p.added) {
    el.classList.add("mod-panel");
    document.body.append(el);
  }
  el.hidden = false;
  if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
  releaseKeys();
  keys.clear();
  panel = p;
  if (document.pointerLockElement) document.exitPointerLock();
  el.focus({ preventScroll: true });
  return { close: () => panel === p && closePanel() };
}
function closePanel(relock = true) {
  const p = panel;
  if (!p) return;
  panel = null;
  if (p.added) p.el.remove();
  else p.el.hidden = true;
  if (p.onClose) guarded(p.mod, "panel onClose", p.onClose);
  if (relock && p.relock) capture();
}

function reorder() {
  ordered = [...mods.values()].sort((a, b) => (a.mod.order ?? 0) - (b.mod.order ?? 0) || a.name.localeCompare(b.name));
  physics.grounds = ordered.flatMap((m) => [...m.grounds]);
  applyScreen();
}

/** The mod whose hook is running, so what it creates is counted against it. */
let running: Loaded | null = null;

// What a mod's hooks hang on the page, the canvas or the clock outlives its elements; it is taken down when the mod leaves the player's game.
const lasting = (target: EventTarget) => target === window || target === document || target === document.body || target === renderer.domElement;
const addListener = EventTarget.prototype.addEventListener;
EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, fn: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
  if (running && fn && lasting(this)) running.traces.push({ listener: [this, type, fn, typeof options === "object" ? { capture: options.capture } : options] });
  return addListener.call(this, type, fn, options);
};
const startInterval = window.setInterval;
window.setInterval = function (...args: Parameters<typeof setInterval>) {
  const id = startInterval.apply(window, args);
  running?.traces.push({ interval: id as unknown as number });
  return id;
} as typeof setInterval;
/** A mod leaving for good takes what its dispose forgot: its listeners and intervals, and the scene objects its code added at the top level. */
function sweep(m: Loaded) {
  for (const t of m.traces) {
    if ("interval" in t) clearInterval(t.interval);
    else t.listener[0].removeEventListener(t.listener[1], t.listener[2], t.listener[3]);
  }
  for (const o of [...scene.children]) if (o.userData.mod === m.name) scene.remove(o);
}

function guarded<T>(m: Loaded, label: string, fn: () => T): T | undefined {
  const prev = running;
  running = m;
  try {
    return fn();
  } catch (e: any) {
    console.error(`[${m.name}] ${label}`, e);
    // The past can hold states a mod's current version never saw: that is no live fault to report or switch the mod off for.
    if (replay) return;
    send({ t: "error", mod: m.name, text: `${label}: ${e?.stack ?? e}` });
    if (++m.errors >= 10 && mods.get(m.name) === m) {
      mods.delete(m.name);
      reorder();
      toast(`${m.name} kept crashing in your game and was switched off`, "error");
    }
  } finally {
    running = prev;
  }
}

/** Geometries and textures not yet disposed, by the mod whose hook created them; "engine" also holds what mods create in async callbacks. */
const made = { geometries: new Map<string, number>(), textures: new Map<string, number>() };
function countMade(proto: { dispose(): void }, counts: Map<string, number>) {
  const owner = Symbol("owner");
  const uuid = Symbol("uuid");
  // Three's constructors assign uuid first thing, which makes its setter the one place every instance passes through.
  Object.defineProperty(proto, "uuid", {
    configurable: true,
    get() {
      return this[uuid];
    },
    set(value: string) {
      if (!(owner in this)) {
        this[owner] = running?.name ?? "engine";
        counts.set(this[owner], (counts.get(this[owner]) ?? 0) + 1);
      }
      this[uuid] = value;
    },
  });
  const dispose = proto.dispose;
  proto.dispose = function (this: any) {
    if (this[owner]) counts.set(this[owner], counts.get(this[owner])! - 1);
    this[owner] = null;
    dispose.call(this);
  };
}
countMade(THREE.BufferGeometry.prototype, made.geometries);
countMade(THREE.Texture.prototype, made.textures);
const topMade = (counts: Map<string, number>) => Object.fromEntries([...counts].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 10));

function call(m: Loaded, hook: keyof ClientHooks, ...args: any[]): any {
  const base = m.mod[hook] as ((...a: any[]) => any) | undefined;
  let next = (...a: any[]) => guarded(m, hook, () => base?.call(m.mod, m.ctx, ...a));
  for (const w of ordered) {
    const fn = w !== m ? (w.mod.wrap?.[m.name]?.[hook] as ((...a: any[]) => any) | undefined) : undefined;
    if (!fn) continue;
    const inner = next;
    next = (...a: any[]) => guarded(w, `wrap ${m.name}.${hook}`, () => fn.call(w.mod, inner, w.ctx, ...a));
  }
  if (hook === "render") return next(...args);
  const started = performance.now();
  const result = next(...args);
  m.ms += performance.now() - started;
  return result;
}

const has = (name: string) => !!mods.get(name)?.mod.exports;
function use(name: string) {
  const target = mods.get(name);
  if (!target?.mod.exports) throw new Error(`${name} is not loaded or exports nothing. If your mod works without it, check ctx.has("${name}") before use.`);
  return Object.fromEntries(Object.entries(target.mod.exports).map(([k, fn]) => [k, (...a: any[]) => fn.call(target.mod.exports, target.ctx, ...a)])) as any;
}

/** Materials disposed while a mod is swapped stay alive until the next frame is drawn, so the new version's identical materials reuse their compiled shaders instead of stalling that frame to compile them again. */
let heldMaterials: THREE.Material[] | null = null;
const disposeMaterial = THREE.Material.prototype.dispose;
THREE.Material.prototype.dispose = function () {
  if (heldMaterials) heldMaterials.push(this);
  else disposeMaterial.call(this);
};

/** Mods load one at a time in the order the server sent them, so a slow import never lands an old version over a newer one. */
let loading = Promise.resolve();
const queue = (load: () => Promise<unknown>) => (loading = loading.then(load).then(() => {}, (e) => console.error(e)));
/** The client builds the server has live; a timelapse puts them back when it ends. */
let live = new Map<string, string>();

async function loadMod(name: string, url: string | null, rebuild = true) {
  const old = mods.get(name);
  // Unloading a mod this game never had is what players in other games hear when it changes.
  if (old?.url === url || (!old && !url)) return;
  let mod: ClientMod | null = null;
  if (url) {
    try {
      mod = (await import(url)).default ?? {};
    } catch (e: any) {
      if (!replay) send({ t: "error", mod: name, text: `import: ${e?.stack ?? e}` });
      return;
    }
  }
  if (old) {
    heldMaterials ??= [];
    call(old, "dispose");
    for (const el of old.owned) el.remove();
    if (panel?.mod === old) closePanel();
    bindings = bindings.filter((b) => b.mod !== old);
    for (const [code, b] of held) if (b.mod === old) held.delete(code);
    mods.delete(name);
    pruneTabs();
    if (!url) sweep(old);
  }
  keysChanged(name);
  if (!mod || !url) {
    reorder();
    return rebuild && rebuildAll();
  }
  const ctx: ClientCtx = {
    THREE,
    scene,
    camera,
    renderer,
    entities,
    objects,
    physics: {
      boxes: (x, z, radius) => physics.boxes(x, z, radius),
      groundAt: (x, z, fromY) => physics.groundAt(x, z, fromY),
      move: (pos, vel, dt, body) => physics.move(pos, vel, dt, body),
      ray: (origin, dir, maxDistance) => physics.ray(origin, dir, maxDistance),
      ground(fn) {
        const g: Ground = (x, z, fromY) => guarded(loaded, "ground", () => fn(x, z, fromY)) ?? null;
        loaded.grounds.add(g);
        reorder();
        return () => void (loaded.grounds.delete(g) && reorder());
      },
    },
    playerId: (replay && director.shot?.player) || me,
    get game() {
      return game;
    },
    keys,
    send: (msg) => !replay && send({ t: "m", mod: name, msg }),
    use,
    has,
    asset: (file) => `/assets/${file.includes("/") ? file : `${name}/${file}`}`,
    menuTab: (title) => {
      const block = Object.assign(document.createElement("div"), { slot: menuPage(title) });
      ui.append(block);
      loaded.owned.push(block);
      return block;
    },
    openMenu: (title) => {
      if (replay || spectator) return { close() {} };
      const opened = menu.hidden;
      void openMenu();
      if (title) openPage(menuPage(title));
      const at = menuOpenedAt;
      return { close: () => opened && !menu.hidden && menuOpenedAt === at && closeMenu() };
    },
    layer: () => {
      const el = document.createElement("div");
      $("layers").append(el);
      loaded.owned.push(el);
      return el;
    },
    screen: (settings) => {
      loaded.screen = settings;
      if (mods.get(name) === loaded) applyScreen();
    },
    hud: (area) => {
      const el = document.createElement("div");
      $(`hud-${area}`).append(el);
      loaded.owned.push(el);
      return el;
    },
    interact: (action) => {
      loaded.actions.add(action);
      return () => void loaded.actions.delete(action);
    },
    key: (code, label, run, opts) => declareKey(loaded, code, label, run, opts),
    panel: (el, opts) => openPanel(loaded, el, opts?.onClose),
    inputFree,
    audio,
    shake: (strength, seconds) => void (seconds > 0 && shakes.push({ strength, seconds, left: seconds })),
  };
  const loaded: Loaded = { name, url, mod, ctx, errors: 0, ms: 0, owned: [], actions: new Set(), grounds: new Set(), screen: {}, traces: [] };
  mods.set(name, loaded);
  reorder();
  call(loaded, "init");
  if (rebuild && (mod.object || old?.mod.object)) rebuildAll();
}

/** The slot for mods' blocks on the menu page with this title: mods share pages by title, join the engine's by using its title, and a page no mod fills any more goes away. Resume, Timelapse and Leave are the engine's. */
const CORE_PAGES = ["claude", "invite", "builders", "mods", "settings", "world"];
const PAGE_ALIASES: Record<string, string> = { help: "Settings", controls: "Settings" };
const ENGINE_ENTRIES = ["resume", "timelapse", "leave"];
let pageSeq = 0;
const slotFor = (section: HTMLElement) => section.appendChild(Object.assign(document.createElement("slot"), { name: section.dataset.tab }));
for (const section of $("pages").querySelectorAll<HTMLElement>("section[data-tab]")) slotFor(section);
function menuPage(title: string) {
  const name = title.trim().toLowerCase();
  if (ENGINE_ENTRIES.includes(name)) throw new Error(`${title} belongs to the engine's menu; pick another title`);
  const wanted = PAGE_ALIASES[name] ?? title;
  let button = [...$("rail").querySelectorAll<HTMLElement>("[data-tab]")].find((b) => b.textContent!.trim().toLowerCase() === wanted.trim().toLowerCase());
  if (!button) {
    const id = `page-${++pageSeq}`;
    button = Object.assign(document.createElement("button"), { className: "item", textContent: wanted.trim() });
    const section = document.createElement("section");
    button.dataset.tab = section.dataset.tab = id;
    section.hidden = true;
    button.onclick = () => openPage(id);
    $("mod-pages").append(button);
    $("pages").append(section);
    slotFor(section);
  }
  return button.dataset.tab!;
}
/** What matches on a menu page, then in the mods' blocks slotted into it, in the order it shows. */
const onPage = (section: Element, selector: string) => [...section.querySelectorAll<HTMLElement>(selector), ...section.querySelector("slot")!.assignedElements().flatMap((block) => [...block.querySelectorAll<HTMLElement>(selector)])];
function pruneTabs() {
  for (const section of $("pages").querySelectorAll<HTMLElement>("section[data-tab]")) {
    const tab = section.dataset.tab!;
    if (CORE_PAGES.includes(tab) || section.querySelector("slot")!.assignedElements().length) continue;
    const button = $("rail").querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (button?.classList.contains("active")) showTab(null);
    button?.remove();
    section.remove();
  }
}

/** One E prompt for the whole game: the nearest action any mod offers. */
function nearestAction() {
  let best: { mod: Loaded; action: Action } | null = null;
  let bestDistance = Infinity;
  for (const mod of mods.values())
    for (const action of mod.actions) {
      let d: number | null = null;
      try {
        d = action.distance();
      } catch (e: any) {
        mod.actions.delete(action);
        send({ t: "error", mod: mod.name, text: `interact distance(): ${e?.stack ?? e}` });
      }
      if (d !== null && d < bestDistance) [best, bestDistance] = [{ mod, action }, d];
    }
  return best;
}
function runAction() {
  const near = nearestAction();
  if (!near) return;
  send({ t: "act", what: "interact", detail: near.mod.name });
  try {
    near.action.run();
  } catch (e: any) {
    send({ t: "error", mod: near.mod.name, text: `interact run(): ${e?.stack ?? e}` });
  }
}
function showAction() {
  let near = menu.hidden && palette.hidden && !panel ? nearestAction() : null;
  let label = "";
  try {
    label = near ? (typeof near.action.label === "function" ? near.action.label() : near.action.label) : "";
  } catch (e: any) {
    near!.mod.actions.delete(near!.action);
    send({ t: "error", mod: near!.mod.name, text: `interact label(): ${e?.stack ?? e}` });
    near = null;
  }
  $("interact").hidden = !near;
  const span = $("interact").querySelector("span")!;
  if (span.textContent !== label) span.textContent = label;
}
$("interact").onclick = runAction;

// ---------- games ----------
/** The game this player is in, or null in the world's own hub. */
let game: string | null = null;
let gameList: Game[] = [];
/** The picker opens once the player is in, the first time the world has games. */
let pickerDue = true;
const picker = mountPicker(uiRoot, {
  get me() {
    return me;
  },
  onPlay: (id) => send({ t: "enterGame", game: id }),
  onClose: () => capture(),
  paintArt(id) {
    const art = gameList.find((g) => g.id === id)?.art;
    const m = art ? mods.get(art) : undefined;
    const paint = m?.mod.paintCard;
    return m && paint ? (canvas, t) => void guarded(m, "paintCard", () => paint.call(m.mod, canvas, t, id)) : null;
  },
});
function openPicker() {
  if (!gameList.length || spectator || replay) return;
  releaseKeys();
  keys.clear();
  if (document.pointerLockElement) document.exitPointerLock();
  picker.open();
}

// ---------- network ----------
/** Loads the server's live client builds and unloads the rest. Every mod downloads at once, then they start in order, each import a task of its own so frames draw in between, and each mod draws the entities it takes over as it starts. */
async function loadLive(list: { name: string; url: string }[], progress?: (started: number, total: number) => void) {
  const wanted = new Map(list.map((m) => [m.name, m.url]));
  live = wanted;
  queue(() => Promise.allSettled([...wanted.values()].map((url) => import(url))));
  const modMs: [string, number][] = [];
  for (const name of mods.keys()) if (!wanted.has(name)) queue(() => loadMod(name, null, false).then(() => reclaim(name)));
  for (const [name, url] of wanted)
    queue(async () => {
      const started = performance.now();
      await loadMod(name, url, false);
      reclaim(name);
      modMs.push([name, Math.round(performance.now() - started)]);
      progress?.(modMs.length, wanted.size);
    });
  await loading;
  return modMs;
}

function connect() {
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws?key=${key}`);
  socket = ws;
  ws.onmessage = async ({ data }) => {
    stats.bytes += data.length;
    const msg = JSON.parse(data);
    switch (msg.t) {
      case "pong":
        stats.ping = Math.round(performance.now() - msg.at);
        return;
      case "welcome": {
        world = msg.world;
        invite = msg.invite;
        link = msg.link;
        wifiOnly = msg.wifiOnly;
        showInvite();
        voiceAvailable = msg.voice;
        voiceHost = msg.host;
        listen();
        me = msg.playerId;
        $("world-name").textContent = world;
        $("rules").textContent = "Add only";
        $("rules").hidden = msg.rules !== "additive";
        $("status").hidden = true;
        welcomedAt = performance.now();
        let firstFrameMs = 0;
        requestAnimationFrame(() => (firstFrameMs = Math.round(performance.now())));
        showClaude(msg.claudes[me]?.state ?? "offline");
        claudes = new Map(Object.entries(msg.claudes));
        showBuilders();
        $("menu-talk").replaceChildren();
        for (const line of msg.talk) addTalk(line.from, line.text);
        leaveReplay();
        game = msg.game ?? null;
        for (const f of msg.feed) addLine(f.text, f.kind);
        const go = $<HTMLButtonElement>("howto-play");
        go.disabled = true;
        const modMs = await loadLive(msg.mods, (started, total) => (go.textContent = `Starting ${started} of ${total}`));
        go.textContent = "Play";
        go.disabled = false;
        send({
          t: "loaded",
          firstFrameMs,
          modsMs: Math.round(performance.now() - welcomedAt),
          slowestMods: Object.fromEntries(modMs.sort((a, b) => b[1] - a[1]).slice(0, 5)),
          screen: `${innerWidth}x${innerHeight}`,
        });
        return;
      }
      case "voice":
        voiceAvailable = msg.on;
        return listen();
      case "voice-failed":
        return toast(hosting && msg.refused ? `${msg.provider} refused the voice key. Add it again in Settings.` : "Voice didn't go through. Try again.", "error");
      case "let-in":
        return letIn(msg.id, msg.name);
      case "public":
        link = msg.link;
        wifiOnly = msg.wifiOnly;
        return showInvite();
      case "claude":
        if (msg.name === me) showClaude(msg.state);
        claudes.set(msg.name, { state: msg.state, task: msg.task });
        return showBuilders();
      case "tick":
        if (!replay) applyTick(msg);
        return;
      case "mod":
        if (msg.url) live.set(msg.name, msg.url);
        else live.delete(msg.name);
        // Loads whichever build is live by the time its turn comes, so versions that arrive in quick succession load once.
        return !replay && queue(() => loadMod(msg.name, live.get(msg.name) ?? null));
      case "games":
        gameList = msg.games;
        picker.update(msg.games, msg.seats, msg.mods ?? {});
        $("menu-games").hidden = !gameList.length;
        if (pickerDue && gameList.length) {
          pickerDue = false;
          if (howto.hidden) openPicker();
          else pickerAfterHowto = true;
        }
        return;
      case "gameSwitch":
        // The old game's mods and entities go before the new game's arrive, under the picker's cover.
        if (msg.phase === "start") {
          if (msg.game) picker.switching(msg.game);
          game = msg.game;
          applyTick({ reset: true, set: {}, unset: {}, removed: [] });
          void loadLive(msg.mods);
          return;
        }
        picker.switching(null);
        if (msg.phase === "done") picker.close();
        else toast(msg.reason ?? "That game couldn't be opened.", "error");
        return;
      case "shot":
        return send({ t: "shot", id: msg.id, data: await screenshot() });
      case "colliders":
        return showColliders(msg.on);
      case "feed":
        addLine(msg.text, msg.kind);
        if (msg.kind === "error") toast(msg.text, msg.kind);
        return;
      case "announce":
        addLine(`${msg.title}${msg.text ? ` · ${msg.text}` : ""}  (${msg.by}'s Claude)`, "mod").style.setProperty("--c", msg.color);
        banners.push(msg);
        askReaction(msg);
        return nextBanner();
      case "votes":
        if (msg.mod === reacting) {
          $("react").querySelector("[data-kind=love] span")!.textContent = msg.love ? String(msg.love) : "";
          $("react").querySelector("[data-kind=undo] span")!.textContent = `${msg.undo}/${msg.needed}`;
        }
        if (!menu.hidden) refreshMenu();
        return;
      case "chat":
        return addLine(...chatLine(msg.from, msg.text, msg.spoken));
      case "talk":
        return addTalk(msg.from, msg.text);
    }
  };
  ws.onclose = (e) => {
    $("status").hidden = false;
    $("rules").hidden = true;
    $<HTMLButtonElement>("howto-play").disabled = true;
    if (leaving) return;
    if (e.code === 4000) {
      $("status").textContent = "You're playing in another tab. Come back to this one to play here.";
      replaced = true;
      return;
    }
    if (e.code === 4001) return location.reload();
    if (e.code === 4002) {
      $("status").textContent = "The host removed you from this world.";
      return;
    }
    $("status").textContent = "Reconnecting…";
    setTimeout(reconnect, 1000);
  };
}

/** The tab you came back to last is the one you play in, so it is also the one screenshots see. */
let replaced = false;
function takeOver() {
  if (!replaced || document.hidden) return;
  replaced = false;
  $("status").textContent = "Reconnecting…";
  void reconnect();
}
addEventListener("focus", takeOver);
document.addEventListener("visibilitychange", takeOver);

/** Back in once the world answers again; while the host has it closed, the game says so. */
async function reconnect() {
  const res = await fetch("/api/info").catch(() => null);
  if (res?.status === 503) $("status").textContent = "The host closed the world. You're back in when they open it.";
  if (!res?.ok) return void setTimeout(reconnect, 2000);
  const now = await res.json();
  // A host that updated serves a new client, so the page reloads to run it.
  if (now.id !== info.id || now.build !== info.build) return location.reload();
  connect();
}

/** The scene with every mod layer and HTML overlay (engine HUD and mod UI) drawn on top, as base64 JPEG at most 1280 px wide. */
async function screenshot() {
  const scale = Math.min(1, 1280 / innerWidth);
  const [w, h] = [Math.round(innerWidth * scale), Math.round(innerHeight * scale)];
  const out = Object.assign(document.createElement("canvas"), { width: w, height: h });
  const g = out.getContext("2d")!;
  g.imageSmoothingEnabled = !screen.pixelated;
  // Copied while the frame is still in the drawing buffer, instead of encoding it to PNG and decoding it again on the main thread.
  if (screen.scene !== false) {
    draw(0);
    g.drawImage(renderer.domElement, 0, 0, w, h);
  }
  // html-to-image waits on animation frames, which never come in a background tab and crawl in a covered or busy one.
  const overlay = document.hidden
    ? "The game tab is in the background: 3D view only, no HUD or menus."
    : await Promise.race([
        toCanvas(document.body, {
          filter: (node) => node !== renderer.domElement && !(node as HTMLElement).hidden && (!(node instanceof Element) || node.checkVisibility()),
          skipFonts: true,
          pixelRatio: scale,
          style: { background: "transparent" },
        }).catch(() => "The HUD and menus could not be drawn: 3D view only."),
        new Promise<string>((resolve) => setTimeout(() => resolve("The HUD and menus took over 3 s to draw: 3D view only."), 3000)),
      ]);
  if (typeof overlay !== "string") g.drawImage(overlay, 0, 0, w, h);
  else {
    g.font = "bold 18px sans-serif";
    g.fillStyle = "#000a";
    g.fillRect(0, 0, w, 36);
    g.fillStyle = "#fff";
    g.fillText(overlay, 12, 24);
  }
  // toBlob encodes off the main thread; toDataURL would block the game while it encodes.
  const jpeg = await new Promise<Blob>((resolve) => out.toBlob((b) => resolve(b!), "image/jpeg", 0.8));
  return new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.readAsDataURL(jpeg);
  });
}

/** The host's own view of their world, without the HUD or name tags, is its picture in Worlds and Browse: sent every few minutes and as they leave. Name tags, the engine's and mods', are sprites drawn from a canvas. */
const hostsThisWorld = hosting?.running?.id === info.id;
function sendCover(keepalive: boolean) {
  if (!hostsThisWorld || !me || replay || screen.scene === false) return;
  const tags: THREE.Object3D[] = [];
  scene.traverseVisible((o) => void ((o as THREE.Sprite).isSprite && ((o as THREE.Sprite).material.map as THREE.CanvasTexture | null)?.isCanvasTexture && tags.push(o)));
  for (const tag of tags) tag.visible = false;
  draw(0);
  const from = renderer.domElement;
  const h = Math.min(from.height, (from.width * 9) / 16);
  const w = (h * 16) / 9;
  const out = Object.assign(document.createElement("canvas"), { width: 960, height: 540 });
  out.getContext("2d")!.drawImage(from, (from.width - w) / 2, (from.height - h) / 2, w, h, 0, 0, 960, 540);
  for (const tag of tags) tag.visible = true;
  // Encoded synchronously, since the page may be going away, and small enough for a keepalive request (64 KB).
  let jpeg = "";
  for (const quality of [0.8, 0.6, 0.4]) if ((jpeg = out.toDataURL("image/jpeg", quality)).length < 80_000) break;
  const body = Uint8Array.from(atob(jpeg.split(",")[1]!), (c) => c.charCodeAt(0));
  fetch(`/api/menu/cover?id=${info.id}`, { method: "POST", keepalive, headers: { authorization: `Bearer ${hostKey}` }, body }).catch(() => {});
}
setInterval(() => document.hidden || sendCover(false), 3 * 60_000);
addEventListener("pagehide", () => sendCover(true));

// ---------- HUD ----------
function addLine(text: string, kind = "info", feed = $("feed")) {
  const line = document.createElement("div");
  line.className = `line ${kind}`;
  line.textContent = text;
  feed.append(line);
  // It fades after a while and comes back while the chat is open.
  setTimeout(() => line.classList.add("old"), 10_000);
  while (feed.children.length > 40) feed.firstElementChild!.remove();
  feed.scrollTop = 1e9;
  return line;
}
const chatLine = (from: string, text: string, spoken?: boolean) =>
  [`${from}${spoken ? " (voice)" : ""}: ${text}`, from.endsWith("'s Claude") ? "claude" : spoken ? "chat spoken" : "chat"] as const;

/** After a mod arrives, players have 30 s to love it or vote it out. */
let reacting = "";
let reactTimer: ReturnType<typeof setTimeout> | undefined;
function askReaction(a: { mod: string; title: string; color: string; author: string }) {
  if (a.author === me) return;
  reacting = a.mod;
  const bar = $("react");
  bar.style.setProperty("--c", a.color);
  $("react-mod").textContent = a.title;
  for (const b of bar.querySelectorAll("button")) {
    b.classList.remove("picked");
    b.querySelector("span")!.textContent = "";
  }
  bar.hidden = false;
  clearTimeout(reactTimer);
  reactTimer = setTimeout(() => (bar.hidden = true), 30_000);
}
function react(kind: string) {
  const button = $("react").querySelector<HTMLElement>(`[data-kind=${kind}]`)!;
  if ($("react").hidden || button.classList.contains("picked")) return;
  for (const b of $("react").querySelectorAll("button")) b.classList.toggle("picked", b === button);
  send({ t: "react", mod: reacting, kind });
}
for (const b of $("react").querySelectorAll<HTMLElement>("button")) b.onclick = () => react(b.dataset.kind!);

/** The timelapse: the last three hours replayed tick by tick through the same pipeline as live play, directed as shots of where things were built. */
type Replay = { frames: Moment[]; plan: Plan; at: number; clock: number; step: number; speed: number; playing: boolean; free: boolean; ended: number; fog: THREE.Scene["fog"]; far: number };
let replay: Replay | null = null;
const SPEEDS = [0.5, 1, 2, 4];
/** `orbiting` is whether the engine's camera frames the shot, rather than a mod's replay hook or the game's own camera. */
const director = { shot: null as Shot | null, started: 0, angle: 0, focus: new THREE.Vector3(), distance: 30, cut: true, orbiting: true };
const freeCam = { yaw: 0, pitch: 0.6, distance: 60, pointers: new Map<number, { x: number; y: number }>() };
const replayKeys = new Set<string>();
const replayLayer = new THREE.Group();
const trails = new Map<string, { id: number; tag: THREE.Sprite; dots: THREE.Points; past: number[] }>();
let marks: THREE.Points | null = null;
const TRAIL = 16;

/** Loads and plays the timelapse; says why when it can't. */
async function playTimelapse() {
  try {
    const res = await fetch("/api/timelapse", { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) return toast(`The timelapse didn't load: the server answered ${res.status}. Try again in a moment.`, "error");
    const frames: Moment[] = await res.json();
    if (frames.length < 2) return toast("Nothing to replay yet: the world records a moment every two seconds, so come back in a minute.");
    startReplay(frames);
    return true;
  } catch (e: any) {
    console.error(e);
    return toast(e instanceof TypeError ? "The timelapse didn't load: the server can't be reached. Try again in a moment." : "The timelapse couldn't be played. Try again in a moment.", "error");
  }
}
$("timelapse").onclick = async () => {
  const button = $<HTMLButtonElement>("timelapse");
  button.disabled = true;
  button.textContent = "Loading…";
  const played = await playTimelapse();
  button.disabled = false;
  button.textContent = "Timelapse";
  if (played) showMenu(false);
};

function startReplay(frames: Moment[]) {
  // About 70 s at normal speed, and shots of about 4 s.
  const step = Math.min(400, Math.max(50, 70_000 / frames.length));
  const planned = plan(frames, Math.max(1, Math.round(4000 / step)));
  keys.clear();
  document.body.classList.remove("replay-hud");
  replay = { frames, plan: planned, at: 0, clock: 0, step, speed: 1, playing: true, free: false, ended: 0, fog: scene.fog, far: camera.far };
  document.body.classList.add("replaying");
  dispatchEvent(new Event("resize"));
  for (const id of ["replay", "replay-bar", "replay-feed"]) $(id).hidden = false;
  camera.far = 10_000;
  camera.updateProjectionMatrix();
  scene.add(replayLayer);
  $("replay-marks").replaceChildren(
    ...planned.markers.map((m) => {
      const i = document.createElement("i");
      i.style.left = `${(m.tick / (frames.length - 1)) * 100}%`;
      if (m.color) i.style.setProperty("--c", m.color);
      return i;
    }),
  );
  $("replay-chapters").querySelector("ul")!.replaceChildren(
    ...planned.chapters.map((first) => {
      const shot = planned.shots[first]!;
      const li = document.createElement("li");
      const [time, ...what] = shot.caption.split(" · ");
      li.innerHTML = "<span class=caps></span><b></b>";
      li.querySelector("span")!.textContent = time!;
      li.querySelector("b")!.textContent = what.join(" · ");
      li.onclick = () => {
        seek(shot.from);
        toggleChapters();
      };
      return li;
    }),
  );
  seek(0);
}

function leaveReplay() {
  const r = replay;
  if (!r) return;
  if (watching) return location.assign("menu");
  replay = null;
  director.shot = null;
  replayKeys.clear();
  freeCam.pointers.clear();
  document.body.classList.remove("replaying");
  dispatchEvent(new Event("resize"));
  for (const id of ["replay", "replay-bar", "replay-feed", "replay-caption", "replay-chapters", "announce"]) $(id).hidden = true;
  for (const m of mods.values()) m.ctx.playerId = me;
  entities.delete(VIEWER);
  scene.remove(replayLayer);
  for (const t of trails.values()) forget(t.tag, t.dots);
  trails.clear();
  if (marks) forget(marks);
  marks = null;
  scene.fog = r.fog;
  camera.far = r.far;
  camera.updateProjectionMatrix();
  syncMods();
  send({ t: "resync" });
  nextBanner();
}

/** Swaps in the client builds that were live at the replay's moment, or the live ones once it ends; seeks while it loads coalesce into one swap. */
let syncing = false;
function syncMods() {
  if (syncing) return;
  syncing = true;
  queue(async () => {
    syncing = false;
    const wanted = new Map<string, string | null>(replay ? [] : live);
    if (replay) for (const f of replay.frames.slice(0, replay.at + 1)) for (const [name, url] of Object.entries(f.mods ?? {})) wanted.set(name, url);
    let rebuild = false;
    for (const name of new Set([...mods.keys(), ...wanted.keys()])) {
      const url = wanted.get(name) ?? null;
      if ((mods.get(name)?.url ?? null) === url) continue;
      rebuild ||= !!mods.get(name)?.mod.object;
      await loadMod(name, url, false);
      rebuild ||= !!mods.get(name)?.mod.object;
    }
    if (rebuild) rebuildAll();
  });
}

/** Jumps to a moment: the world as it was then, rebuilt from the nearest checkpoint, with what was said just before. */
function seek(tick: number) {
  const r = replay!;
  r.at = Math.max(0, Math.min(r.frames.length - 1, Math.round(tick)));
  r.clock = 0;
  r.ended = 0;
  applyTick({ reset: true, set: structuredClone(r.plan.stateAt(r.at)), unset: {}, removed: [] });
  for (const t of trails.values()) t.past.length = 0;
  $("replay-feed").replaceChildren();
  for (const f of r.frames.slice(Math.max(0, r.at - 3), r.at + 1)) happen(f.activity, false);
  syncMods();
  director.shot = null;
  showFrame();
  showControls();
}

/** Plays forward in the render loop, a recorded moment every `step` ms at normal speed. */
function advance(dt: number, now: number) {
  const r = replay!;
  if (r.ended && !r.free && now - r.ended > 8000) return leaveReplay();
  if (!r.playing) return;
  r.clock = Math.min(r.clock + dt * 1000 * r.speed, r.step * 8);
  while (r.clock >= r.step && r.at < r.frames.length - 1) {
    r.clock -= r.step;
    const frame = r.frames[++r.at]!;
    applyTick(structuredClone(frame));
    happen(frame.activity, true);
    if (frame.mods) syncMods();
    showFrame();
  }
  if (r.at === r.frames.length - 1) {
    r.playing = false;
    r.ended = now;
    showControls();
  }
}

function showFrame() {
  const r = replay!;
  const last = r.at === r.frames.length - 1;
  const shot = last ? r.plan.shots.at(-1)! : r.plan.shots.findLast((s) => s.from <= r.at)!;
  if (shot !== director.shot) direct(shot);
  $("replay-time").textContent = clock(r.frames[r.at]!.at);
  $("replay-head").style.left = `${(r.at / (r.frames.length - 1)) * 100}%`;
  trace();
  drawTrack();
}

function showControls() {
  const r = replay!;
  $("replay-play").firstChild!.textContent = r.playing ? "Pause" : r.at === r.frames.length - 1 ? "Replay" : "Play";
  $("replay-speed").textContent = `${r.speed}×`;
  $("replay-free").firstChild!.textContent = r.free ? "Director" : "Free camera";
  $("replay-free").classList.toggle("on", r.free);
  $<HTMLButtonElement>("replay-free").disabled = !r.free && !director.orbiting;
  $("replay-chapters-button").classList.toggle("on", !$("replay-chapters").hidden);
  $("replay-hud").classList.toggle("on", document.body.classList.contains("replay-hud"));
}
function toggleHud() {
  document.body.classList.toggle("replay-hud");
  showControls();
}

function togglePlay() {
  const r = replay!;
  if (r.at === r.frames.length - 1) {
    seek(0);
    r.playing = true;
  } else r.playing = !r.playing;
  r.ended = 0;
  showControls();
}
function setSpeed(by: number) {
  const r = replay!;
  r.speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(r.speed) + by))]!;
  showControls();
}
function cycleSpeed() {
  const r = replay!;
  r.speed = SPEEDS[(SPEEDS.indexOf(r.speed) + 1) % SPEEDS.length]!;
  showControls();
}
/** Five percent of the timelapse, or with Shift the previous or next chapter. */
function skip(by: number, chapter: boolean) {
  const r = replay!;
  if (!chapter) return seek(r.at + by * Math.max(1, Math.round(r.frames.length / 20)));
  const starts = r.plan.chapters.map((first) => Math.min(r.plan.shots[first]!.from, r.frames.length - 1));
  seek(by > 0 ? (starts.find((s) => s > r.at) ?? r.frames.length - 1) : (starts.findLast((s) => s < r.at - 2) ?? 0));
}
function toggleChapters() {
  $("replay-chapters").hidden = !$("replay-chapters").hidden;
  showControls();
  showChapter();
}
function toggleFree() {
  const r = replay!;
  if (!r.free && !director.orbiting) return;
  r.free = !r.free;
  r.ended = 0;
  if (r.free) {
    const offset = camera.position.clone().sub(director.focus);
    freeCam.distance = Math.max(3, offset.length());
    freeCam.yaw = Math.atan2(offset.z, offset.x);
    freeCam.pitch = Math.asin(Math.max(-1, Math.min(1, offset.y / freeCam.distance)));
  } else if (director.shot) direct(director.shot);
  showControls();
}

function replayKey(e: KeyboardEvent) {
  if (e.code === "Tab") {
    e.preventDefault();
    leaveReplay();
    return openMenu();
  }
  if (e.code === "Escape") {
    leaveReplay();
    return capture();
  }
  const act: Record<string, () => void> = {
    Space: togglePlay,
    ArrowLeft: () => skip(-1, e.shiftKey),
    ArrowRight: () => skip(1, e.shiftKey),
    ArrowUp: () => setSpeed(1),
    ArrowDown: () => setSpeed(-1),
    KeyC: toggleChapters,
    KeyF: toggleFree,
    KeyH: toggleHud,
  };
  if (!act[e.code]) return replayKeys.add(e.code);
  e.preventDefault();
  if (!e.repeat || e.code.startsWith("Arrow")) act[e.code]!();
}

$("replay-play").onclick = togglePlay;
$("replay-speed").onclick = cycleSpeed;
$("replay-free").onclick = toggleFree;
$("replay-hud").onclick = toggleHud;
$("replay-chapters-button").onclick = toggleChapters;
$("replay-chapters").onclick = (e) => e.target === e.currentTarget && toggleChapters();
$("replay-leave").onclick = () => {
  leaveReplay();
  capture();
};

/** The timeline: how much was built when, reloads and banners marked by who, and the playhead; drag it to scrub. */
const track = $("replay-track");
const trackCanvas = track.querySelector("canvas")!;
function drawTrack() {
  const r = replay!;
  const w = track.clientWidth;
  const h = track.clientHeight;
  const scale = Math.min(devicePixelRatio, 2);
  if (trackCanvas.width !== Math.round(w * scale)) [trackCanvas.width, trackCanvas.height] = [Math.round(w * scale), Math.round(h * scale)];
  const g = trackCanvas.getContext("2d")!;
  g.setTransform(scale, 0, 0, scale, 0, 0);
  g.clearRect(0, 0, w, h);
  const bins = Math.max(1, Math.floor(w / 4));
  const sums = new Array<number>(bins).fill(0);
  r.plan.density.forEach((d, i) => (sums[Math.min(bins - 1, Math.floor((i / r.frames.length) * bins))]! += d));
  const most = Math.max(1, ...sums);
  const played = r.at / (r.frames.length - 1);
  sums.forEach((s, i) => {
    g.fillStyle = (i + 0.5) / bins <= played ? "#ffb547" : "rgba(255,255,255,.32)";
    const bar = s ? Math.max(2, Math.sqrt(s / most) * (h - 8)) : 1;
    g.fillRect(i * 4, h - bar, 3, bar);
  });
}
const tickAt = (x: number) => {
  const box = track.getBoundingClientRect();
  return Math.round(Math.max(0, Math.min(1, (x - box.left) / box.width)) * (replay!.frames.length - 1));
};
function showTip(x: number) {
  const r = replay!;
  const tick = tickAt(x);
  const near = r.plan.markers.filter((m) => Math.abs(m.tick - tick) <= r.frames.length / 150);
  const tip = $("replay-tip");
  tip.textContent = [clock(r.frames[tick]!.at), ...near.slice(-3).map((m) => m.label)].join(" · ");
  tip.style.left = `${Math.max(0, Math.min(1, (x - track.getBoundingClientRect().left) / track.clientWidth)) * 100}%`;
  tip.hidden = false;
}
let scrubbing: { at: number } | null = null;
track.onpointerdown = (e) => {
  track.setPointerCapture(e.pointerId);
  scrubbing = { at: 0 };
  scrub(e);
};
track.onpointermove = scrub;
function scrub(e: PointerEvent) {
  if (!replay) return;
  showTip(e.clientX);
  if (!scrubbing) return;
  $("replay-head").style.left = `${(tickAt(e.clientX) / (replay.frames.length - 1)) * 100}%`;
  // Rebuilding the world is the expensive part of a seek, so a drag seeks a few times a second.
  if (performance.now() - scrubbing.at < 150) return;
  scrubbing.at = performance.now();
  seek(tickAt(e.clientX));
}
track.onpointerup = track.onpointercancel = (e) => {
  if (scrubbing && replay) seek(tickAt(e.clientX));
  scrubbing = null;
};
track.onpointerleave = () => !scrubbing && ($("replay-tip").hidden = true);

/** Dragging the view takes the camera from the director; wheel or pinch zooms, WASD moves, Q and E go down and up. */
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (!replay) return;
  freeCam.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  renderer.domElement.setPointerCapture(e.pointerId);
});
renderer.domElement.addEventListener("pointermove", (e) => {
  const was = freeCam.pointers.get(e.pointerId);
  if (!replay || !was) return;
  if (!replay.free && (!director.orbiting || Math.hypot(e.clientX - was.x, e.clientY - was.y) < 4)) return;
  if (!replay.free) toggleFree();
  const others = [...freeCam.pointers].filter(([id]) => id !== e.pointerId);
  if (others.length) {
    const [, o] = others[0]!;
    freeCam.distance *= Math.hypot(was.x - o.x, was.y - o.y) / Math.max(1, Math.hypot(e.clientX - o.x, e.clientY - o.y));
  } else {
    freeCam.yaw += (e.clientX - was.x) * 0.006;
    freeCam.pitch = Math.max(-0.2, Math.min(1.5, freeCam.pitch + (e.clientY - was.y) * 0.006));
  }
  freeCam.distance = Math.max(3, Math.min(4000, freeCam.distance));
  freeCam.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
});
for (const type of ["pointerup", "pointercancel"]) renderer.domElement.addEventListener(type, (e) => freeCam.pointers.delete((e as PointerEvent).pointerId));
renderer.domElement.addEventListener("wheel", (e) => {
  if (!replay || (!replay.free && !director.orbiting)) return;
  if (!replay.free) toggleFree();
  freeCam.distance = Math.max(3, Math.min(4000, freeCam.distance * Math.exp(e.deltaY * 0.001)));
}, { passive: true });

/** Feed lines, chat, voice and banners as they happened; `banners` is false when catching up after a seek. */
function happen(activity: Activity[] | undefined, banners: boolean) {
  for (const a of activity ?? []) {
    if (a.t === "feed") addLine(a.text, a.kind, $("replay-feed"));
    else if (a.t === "chat") addLine(...chatLine(a.from, a.text, a.spoken), $("replay-feed"));
    else {
      addLine(`${a.title}${a.text ? ` · ${a.text}` : ""}  (${a.by}'s Claude)`, "mod", $("replay-feed")).style.setProperty("--c", a.color);
      if (banners) showBanner(a);
    }
  }
  while ($("replay-feed").children.length > 6) $("replay-feed").firstElementChild!.remove();
}

function forget(...objects: (THREE.Sprite | THREE.Points)[]) {
  for (const o of objects) {
    replayLayer.remove(o);
    if (o instanceof THREE.Points) o.geometry.dispose();
    (o.material as THREE.SpriteMaterial).map?.dispose();
    (o.material as THREE.Material).dispose();
  }
}

/** Starts a shot: a cut when the new place is far from what the camera shows, otherwise a quick flight there. */
function direct(shot: Shot) {
  director.cut = !director.shot || !shot.target || director.focus.distanceTo(new THREE.Vector3(...shot.target)) > director.distance * 2.5;
  if (director.cut) director.angle += 2.2;
  director.shot = shot;
  director.started = performance.now();
  const [time, ...what] = shot.caption.split(" · ");
  const caption = $("replay-caption");
  caption.querySelector("span")!.textContent = time!;
  caption.querySelector("b")!.textContent = what.join(" · ");
  caption.hidden = true;
  void caption.offsetWidth;
  caption.hidden = false;
  showChapter();
  if (marks) forget(marks);
  marks = null;
  if (!shot.marks.length) return;
  const geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(shot.marks, 3));
  marks = new THREE.Points(geometry, new THREE.PointsMaterial({ color: "#ffb547", size: 4, sizeAttenuation: false, transparent: true, opacity: 0.6, depthTest: false }));
  marks.renderOrder = 9;
  replayLayer.add(marks);
}

function showChapter() {
  const list = $("replay-chapters");
  const shot = replay && director.shot ? replay.plan.shots.indexOf(director.shot) : -1;
  const index = shot < 0 ? -1 : replay!.plan.chapters.findLastIndex((first) => first <= shot);
  list.querySelectorAll("li").forEach((li, i) => {
    if (li.classList.toggle("active", i === index) && !list.hidden) li.scrollIntoView({ block: "nearest" });
  });
}

/** Every player's avatar gets a name tag and a short trail of where it was over the last moments. */
function trace() {
  const present = new Set<string>();
  for (const [id, e] of entities) {
    if (!isAvatar(e) || !Array.isArray(e.pos) || id === VIEWER) continue;
    present.add(e.player);
    let t = trails.get(e.player);
    if (!t) {
      const tag = labelSprite(labelMaterial(String(e.name ?? e.player)));
      tag.material.sizeAttenuation = false;
      tag.scale.set((0.03 * tag.scale.x) / tag.scale.y, 0.03, 1);
      const geometry = new THREE.BufferGeometry()
        .setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(TRAIL * 3), 3))
        .setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(TRAIL * 4), 4));
      const dots = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false }));
      dots.frustumCulled = false;
      replayLayer.add(tag, dots);
      trails.set(e.player, (t = { id, tag, dots, past: [] }));
    }
    t.id = id;
    t.past.push(...(e.pos as number[]).slice(0, 3));
    t.past.splice(0, Math.max(0, t.past.length - TRAIL * 3));
    const color = new THREE.Color(e.look?.avatar ?? "#ffb547");
    const n = t.past.length / 3;
    const colors = t.dots.geometry.getAttribute("color") as THREE.BufferAttribute;
    (t.dots.geometry.getAttribute("position") as THREE.BufferAttribute).set(t.past).needsUpdate = true;
    for (let i = 0; i < n; i++) colors.setXYZW(i, color.r, color.g, color.b, ((i + 1) / n) * 0.8);
    colors.needsUpdate = true;
    t.dots.geometry.setDrawRange(0, n);
  }
  for (const [player, t] of trails) {
    if (present.has(player)) continue;
    forget(t.tag, t.dots);
    trails.delete(player);
  }
}

/** Mods frame the shot first; otherwise the engine's camera orbits the shot's place slowly at a distance that frames what was built, overviews without fog. */
const VIEWER = -1;
/** When a shot's place is far from its player, the local player is a stand-in avatar at the place, so games that draw what is around their player (a room, a realm, nearby chunks) show it. */
function stand(shot: Shot) {
  const own = shot.player ? [...entities.values()].find((e) => isAvatar(e) && e.player === shot.player && Array.isArray(e.pos)) : undefined;
  const at = shot.target && (director.orbiting ? director.focus.toArray() : shot.target);
  const away = shot.kind !== "follow" && !!at && (!own || Math.hypot(own.pos[0] - at[0], own.pos[1] - at[1], own.pos[2] - at[2]) > Math.max(60, shot.radius));
  if (away) entities.set(VIEWER, { avatar: true, player: "timelapse", pos: at });
  else entities.delete(VIEWER);
  for (const m of mods.values()) m.ctx.playerId = away ? "timelapse" : (shot.player ?? me);
}

function film(dt: number, now: number) {
  const r = replay!;
  const shot = director.shot;
  if (!shot) return;
  for (const t of trails.values()) {
    const obj = objects.get(t.id);
    if (obj) t.tag.position.copy(obj.position).setY(obj.position.y + 2.4);
  }
  stand(shot);
  const about: ReplayShot = { kind: shot.kind, target: shot.target, radius: shot.radius, ids: shot.ids, mod: shot.mod, player: shot.player, caption: shot.caption, elapsed: (now - director.started) / 1000 };
  const framed = !r.free && [...ordered].reverse().some((m) => m.mod.replay && call(m, "replay", about, dt) === true);
  // A game with its own ctx.screen camera or no scene, or whose things have no place, keeps its own view: its hooks already show ctx.playerId's past.
  const orbiting = !framed && !!shot.target && view === camera && screen.scene !== false;
  if (orbiting !== director.orbiting) {
    director.orbiting = orbiting;
    showControls();
  }
  if (!orbiting && !r.free) {
    scene.fog = r.fog;
    return;
  }
  if (r.free) {
    const forward = new THREE.Vector3(-Math.cos(freeCam.yaw), 0, -Math.sin(freeCam.yaw));
    const move = new THREE.Vector3();
    for (const [code, x, y, z] of [["KeyW", 1, 0, 0], ["KeyS", -1, 0, 0], ["KeyD", 0, 0, 1], ["KeyA", 0, 0, -1], ["KeyE", 0, 1, 0], ["KeyQ", 0, -1, 0]] as const)
      if (replayKeys.has(code)) move.add(new THREE.Vector3(forward.x * x - forward.z * z, y, forward.z * x + forward.x * z));
    director.focus.addScaledVector(move, Math.max(12, freeCam.distance) * dt);
    const { yaw, pitch, distance } = freeCam;
    camera.position.copy(director.focus).add(new THREE.Vector3(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)).multiplyScalar(distance));
    camera.lookAt(director.focus);
    scene.fog = distance > 250 ? null : r.fog;
    return;
  }
  const avatar = shot.kind === "follow" ? trails.get(shot.player!) : undefined;
  const goal = (avatar && objects.get(avatar.id)?.position) || new THREE.Vector3(...shot.target!);
  const distance = shot.kind === "overview" ? shot.radius * 1.5 : shot.kind === "follow" ? 16 : Math.min(220, Math.max(22, shot.radius * 2.4));
  const lift = shot.kind === "overview" ? 0.9 : shot.kind === "follow" ? 0.45 : 0.6;
  if (director.cut) {
    director.focus.copy(goal);
    director.distance = distance;
    director.cut = false;
  } else {
    const k = 1 - Math.exp(-dt * 2.5);
    director.focus.lerp(goal, k);
    director.distance += (distance - director.distance) * k;
  }
  const a = director.angle + (now - director.started) * 0.00012;
  const { x, y, z } = director.focus;
  camera.position.set(x + Math.cos(a) * director.distance, y + director.distance * lift, z + Math.sin(a) * director.distance);
  camera.lookAt(director.focus);
  scene.fog = shot.kind === "overview" ? null : r.fog;
}

// ---------- the live view behind the join screen ----------
/** A visitor with an invite watches the world behind the join screen: the server streams what a fresh player would see and nobody in the game sees them. Nothing goes back, since `socket` stays unset; mods run silent, with their HUD hidden as in a replay. */
let spectator: WebSocket | null = null;
/** Where things appeared while watching. */
const built: { at: number; pos: [number, number, number] }[] = [];
const drift = { avatar: -1, pickedAt: -Infinity, goal: new THREE.Vector3(), goalDistance: 40, focus: new THREE.Vector3(), distance: 40, angle: Math.random() * Math.PI * 2, placed: false };

function spectate(invite: string) {
  const ws = (spectator = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws?invite=${encodeURIComponent(invite)}`));
  let opened = false;
  document.body.classList.add("spectating");
  void audio.context.suspend();
  // The menu covers the left of a wide screen and the top of a tall one, so what the camera circles sits right of or below centre.
  const wide = innerWidth > innerHeight;
  camera.setViewOffset(innerWidth, innerHeight, wide ? -innerWidth * 0.18 : 0, wide ? 0 : -innerHeight * 0.12, innerWidth, innerHeight);
  ws.onmessage = ({ data }) => {
    opened = true;
    const msg = JSON.parse(data);
    if (msg.t === "welcome") void loadLive(msg.mods);
    else if (msg.t === "mod") {
      if (msg.url) live.set(msg.name, msg.url);
      else live.delete(msg.name);
      queue(() => loadMod(msg.name, msg.url));
    } else if (msg.t === "tick") {
      if (!msg.reset)
        for (const [id, e] of Object.entries<Entity>(msg.set)) {
          const at = !entities.has(Number(id)) && !isAvatar(e) && position(e);
          if (at) built.push({ at: performance.now(), pos: at });
        }
      built.splice(0, Math.max(0, built.length - 200));
      applyTick(msg);
      $("join-backdrop").classList.add("live");
    }
  };
  ws.onclose = (e) => {
    if (spectator !== ws) return;
    $("join-backdrop").classList.remove("live");
    // A dropped view comes back; a changed invite or a refused connection doesn't.
    if (opened && e.code !== 4003) setTimeout(() => spectator === ws && spectate(invite), 3000);
  };
}

/** Joining keeps the scene and camera where the view left them; mods start over as the player, whose own stream resets the entities. */
function stopSpectating() {
  const ws = spectator;
  if (!ws) return;
  spectator = null;
  ws.onclose = ws.onmessage = null;
  ws.close();
  built.length = 0;
  document.body.classList.remove("spectating");
  camera.clearViewOffset();
  renderer.setPixelRatio(screen.resolution ?? Math.min(devicePixelRatio, 2));
  for (const name of mods.keys()) queue(() => loadMod(name, null, false));
}

/** Every 12 s the view turns to the next player, or with nobody around to what was built in the last minute, else the whole world, and slowly circles it. */
function driftCamera(dt: number, now: number) {
  if (now - drift.pickedAt > 12_000) {
    drift.pickedAt = now;
    const avatars = [...entities].filter(([, e]) => isAvatar(e) && position(e)).map(([id]) => id).sort((a, b) => a - b);
    drift.avatar = avatars[(avatars.indexOf(drift.avatar) + 1) % avatars.length] ?? -1;
    const recent = built.filter((b) => now - b.at < 60_000).map((b) => b.pos);
    const placed = [...entities.values()].flatMap((e) => (isAvatar(e) || !position(e) ? [] : [position(e)!]));
    const { target, radius } = extent(recent.length >= 3 ? recent : placed);
    drift.goal.fromArray(target);
    drift.goalDistance = drift.avatar >= 0 ? 40 : Math.min(160, Math.max(40, radius * (recent.length >= 3 ? 2.4 : 1.5)));
  }
  const at = drift.avatar >= 0 && position(entities.get(drift.avatar) ?? {});
  if (at) drift.goal.fromArray(at);
  // A new subject far off is a cut; a near one, or one on the move, is followed.
  const k = drift.placed && drift.focus.distanceTo(drift.goal) < drift.distance * 4 ? 1 - Math.exp(-dt * 0.6) : 1;
  drift.placed = true;
  drift.focus.lerp(drift.goal, k);
  drift.distance += (drift.goalDistance - drift.distance) * k;
  drift.angle += dt * 0.06;
  // Looking down at about 35°, high enough to clear the buildings around the subject.
  const pitch = 0.62;
  const { x, y, z } = drift.focus;
  const out = Math.cos(pitch) * drift.distance;
  camera.position.set(x + Math.cos(drift.angle) * out, y + Math.sin(pitch) * drift.distance, z + Math.sin(drift.angle) * out);
  camera.lookAt(drift.focus);
}

const banners: { mod: string; by: string; title: string; text: string; color: string }[] = [];
/** Live banners wait while a timelapse plays. */
function nextBanner() {
  const a = !replay && $("announce").hidden && banners.shift();
  if (a) showBanner(a);
}
function showBanner(a: (typeof banners)[number]) {
  const el = $("announce");
  el.hidden = true;
  void el.offsetWidth;
  el.style.setProperty("--c", a.color);
  const [kicker, title, text] = el.children as unknown as HTMLElement[];
  kicker!.textContent = `${a.mod} · by ${a.by}'s Claude`;
  title!.textContent = a.title;
  text!.textContent = a.text;
  text!.hidden = !a.text;
  el.hidden = false;
  el.onanimationend = () => {
    el.hidden = true;
    nextBanner();
  };
}

function toast(text: string, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("toasts").append(el);
  toTop($("toasts"));
  setTimeout(() => el.remove(), 5000);
}

/** The host answers whether a new computer may play as an offline player's name; no answer in a minute means no. */
function letIn(id: string, name: string) {
  const el = document.createElement("div");
  el.className = "toast asking";
  el.textContent = `${name} is joining from a new computer.`;
  const answer = (allow: boolean) => {
    send({ t: "let-in", id, allow });
    el.remove();
  };
  const actions = document.createElement("div");
  actions.className = "actions";
  actions.append(Object.assign(document.createElement("button"), { textContent: "Let in", onclick: () => answer(true) }), Object.assign(document.createElement("button"), { textContent: "No", onclick: () => answer(false) }));
  el.append(actions);
  $("toasts").append(el);
  toTop($("toasts"));
  setTimeout(() => el.remove(), 60_000);
}

const chat = $<HTMLInputElement>("chat");
const menu = $("menu");
/** In the menu, or in a mod's block on one of its pages. */
const inMenu = (el: Element | null) => !!el && (menu.contains(el) || ui.contains(el));
const howto = $("howto");
const palette = $("palette");
const typing = () => {
  const el = focused();
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable);
};
const inputFree = () => !(replay || spectator || typing() || panel || !menu.hidden || !chat.hidden || !howto.hidden || !palette.hidden || picker.isOpen());

/** When a mod asks for mouse-look, clicking the game locks the mouse; the cursor is free again while chat, the menu, a panel or an overlay is open. */
function capture() {
  if (!replay && !spectator && screen.lockPointer && menu.hidden && chat.hidden && howto.hidden && palette.hidden && !panel && !picker.isOpen() && !document.pointerLockElement) renderer.domElement.requestPointerLock()?.catch(() => {});
}
renderer.domElement.addEventListener("click", capture);
/** Mods free the mouse for their own windows through exitPointerLock; a loss nobody asked for (Esc, switching windows) pauses into the menu. */
let unlockAsked = false;
const exitPointerLock = Document.prototype.exitPointerLock;
Document.prototype.exitPointerLock = function () {
  unlockAsked = true;
  return exitPointerLock.call(this);
};
document.addEventListener("pointerlockchange", () => {
  const asked = unlockAsked;
  unlockAsked = false;
  if (!document.pointerLockElement && !asked && inputFree()) void openMenu();
});
// Coming back to the window takes mouse-look straight back where the page may lock without a click (the desktop app); browsers refuse quietly.
addEventListener("focus", capture);
// Right-click belongs to the game, so no browser menu except over text fields.
addEventListener("contextmenu", (e) => (e.target as Element).closest("input, textarea, [contenteditable]") || e.preventDefault());
// Outside the engine's UI a right-click in it looks like one on #ui, so its text fields are let through from in here.
uiRoot.addEventListener("contextmenu", (e) => (e.target as Element).closest("input, textarea, [contenteditable]") && e.stopPropagation());
const ideas = ["add a scoreboard", "make it harder every round", "let us play in teams", "add sound effects", "add a timer and a winner", "give everyone a secret role", "surprise us with a twist"];
function openChat() {
  chat.placeholder = `Chat, or ask your agent: "${ideas[Math.floor(Math.random() * ideas.length)]}"`;
  chat.hidden = false;
  chat.focus();
  releaseKeys();
  startTalking();
  if (document.pointerLockElement) document.exitPointerLock();
}
/** The page knows the menu is open, so the HUD behind it steps aside. */
function showMenu(shown: boolean) {
  menu.hidden = !shown;
  document.body.classList.toggle("menu-open", shown);
  raiseMenu();
}
/** Shows a popover above everything in the top layer, where no z-index reaches. */
function toTop(el: HTMLElement) {
  if (!el.isConnected) return;
  el.hidePopover();
  el.showPopover();
}
/** The open menu is in the top layer with the palette and toasts above it. Whatever a mod puts there later goes back under them, and a mod's modal dialog, which would make the menu inert, closes. */
function raiseMenu() {
  if (menu.hidden) return;
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog:modal")) dialog.close();
  const was = focused();
  toTop(menu);
  if (!palette.hidden) toTop(palette);
  if ($("toasts").childElementCount) toTop($("toasts"));
  if (was instanceof HTMLElement) was.focus({ preventScroll: true });
}
addEventListener("toggle", (e) => e.target !== palette && e.target !== $("toasts") && (e.target as Element).matches(":popover-open, :modal") && raiseMenu(), true);
addEventListener("fullscreenchange", raiseMenu, true);
function closeMenu() {
  showMenu(false);
  showTab(null);
  capture();
}
/** A world with games shows its picker once the how-to is out of the way. */
let pickerAfterHowto = false;
function play() {
  howto.hidden = true;
  if (pickerAfterHowto) {
    pickerAfterHowto = false;
    return openPicker();
  }
  capture();
}
$("menu-games").onclick = () => {
  showMenu(false);
  showTab(null);
  openPicker();
};

/** Push to talk: hold T (or the mic button) and the phrase goes to chat, transcribed by the host, so everyone and every Claude hears it. */
let voiceAvailable = false;
let voiceHost: string | null = null;
let micStream: Promise<MediaStream> | null = null;
let talking: { recorder: Promise<MediaRecorder> } | null = null;
// The stream stays open after the first use so later phrases record from the first word.
const mic = () => (micStream ??= navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }));
const sendVoice = (audio: Blob) => void fetch("/api/voice", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: audio });
function micBlocked() {
  micStream = null;
  toast(desktop ? "Voice needs the microphone. Hold T again to allow it." : "The microphone is blocked. Allow it in the browser's address bar, then try again.", "error");
}
function startTalking() {
  if (!voiceAvailable || talking || listening) return;
  const recorder = mic().then((stream) => {
    const r = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => chunks.push(e.data);
    const began = performance.now();
    // Presses shorter than 300 ms of actual recording are accidental taps, and a press released before the mic was ready recorded nothing.
    r.onstop = () => {
      const audio = new Blob(chunks, { type: r.mimeType });
      if (audio.size && performance.now() - began > 300) sendVoice(audio);
    };
    r.start();
    return r;
  });
  recorder.catch(micBlocked);
  talking = { recorder };
  showMic();
}
/** keep is false when the player typed instead or cancelled, so only what they meant to say is sent. */
function stopTalking(keep: boolean) {
  if (!talking) return;
  const { recorder } = talking;
  talking = null;
  showMic();
  recorder.then((r) => {
    if (!keep) r.onstop = null;
    r.stop();
  }, () => {});
}

/** Always-on mic, remembered on this device: the page picks out each spoken phrase itself, so silence and game sound never leave it. */
let openMic = false;
try {
  openMic = localStorage.getItem("sandbox-open-mic") === "1";
} catch {}
let listening: (() => void) | null = null;
function listen() {
  if (voiceAvailable && openMic) listening ??= hear();
  else {
    listening?.();
    listening = null;
  }
  showMic();
}
function hear() {
  let stop = () => {};
  let stopped = false;
  mic().then(
    (stream) => {
      if (stopped) return;
      const source = audio.context.createMediaStreamSource(stream);
      const tap = audio.context.createScriptProcessor(2048, 1, 1);
      const feed = phrases(audio.context.sampleRate, sendVoice);
      tap.onaudioprocess = (e) => feed(e.inputBuffer.getChannelData(0).slice());
      source.connect(tap);
      // A processor runs only while connected to an output; it writes nothing, so nothing is heard.
      tap.connect(audio.context.destination);
      stop = () => {
        source.disconnect();
        tap.disconnect();
      };
    },
    () => {
      micBlocked();
      setOpenMic(false);
    },
  );
  return () => {
    stopped = true;
    stop();
  };
}
function setOpenMic(on: boolean) {
  openMic = on;
  $<HTMLInputElement>("open-mic").checked = on;
  try {
    localStorage.setItem("sandbox-open-mic", on ? "1" : "0");
  } catch {}
  listen();
}
$<HTMLInputElement>("open-mic").checked = openMic;
$("open-mic").onchange = () => setOpenMic($<HTMLInputElement>("open-mic").checked);

function showMic() {
  $("mic").textContent = !voiceAvailable ? (hosting ? "Turn on voice" : `Voice off: ask ${voiceHost ?? "the host"} to turn it on`) : listening ? "Mic on" : talking ? "Talking" : "Hold T to talk";
  $("mic").dataset.state = !voiceAvailable ? (hosting ? "setup" : "none") : listening || talking ? "on" : "off";
  $("open-mic-field").hidden = !voiceAvailable;
  for (const row of [...document.querySelectorAll<HTMLElement>(".talk-key"), ...uiRoot.querySelectorAll<HTMLElement>(".talk-key")]) row.hidden = !voiceAvailable;
}
$("mic").onclick = () => {
  if (voiceAvailable || !hosting) return;
  openMenu();
  showTab("settings");
  $("voice-key").focus();
};
$("mic").onpointerdown = startTalking;
$("mic").onpointerup = $("mic").onpointerleave = () => stopTalking(true);
showMic();
$("howto-play").onclick = play;

// Capture phase, so mods' own listeners can't swallow declared keys, or Tab, which opens the menu and its votes.
addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.code === "Tab" && !spectator && !(replay && !typing()) && (!typing() || focused()!.closest("#layers") || inMenu(focused()))) {
    e.preventDefault();
    e.stopImmediatePropagation();
    (focused() as HTMLElement).blur();
    return menu.hidden ? openMenu() : closeMenu();
  }
  if (e.code === "Escape" && panel && menu.hidden && chat.hidden && palette.hidden) {
    e.stopImmediatePropagation();
    return closePanel();
  }
  // Ahead of mods' bindings: in a world with games, G is the engine's.
  if (e.code === "KeyG" && engineOwns("KeyG") && !replay && !spectator && !e.repeat && !typing() && !panel && menu.hidden && chat.hidden && howto.hidden && palette.hidden) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return picker.isOpen() ? picker.close() : openPicker();
  }
  if (replay || spectator || e.repeat || e.metaKey || e.ctrlKey || held.has(e.code) || typing() || !menu.hidden || !chat.hidden || !howto.hidden || !palette.hidden || picker.isOpen()) return;
  const b = activeBindings().find((x) => x.code === e.code);
  if (!b) return;
  if (b.up) held.set(e.code, b);
  press(b, true);
}, true);
addEventListener("keyup", (e: KeyboardEvent) => {
  const b = held.get(e.code);
  if (!b) return;
  held.delete(e.code);
  press(b, false);
}, true);

addEventListener("keydown", (e: KeyboardEvent) => {
  if (spectator) return;
  if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") {
    e.preventDefault();
    return palette.hidden ? openPalette() : closePalette();
  }
  if (!howto.hidden) {
    if ((e.code === "Enter" || e.code === "Space") && !$<HTMLButtonElement>("howto-play").disabled) play();
    return;
  }
  if (replay && !typing()) return replayKey(e);
  if (e.code === "Enter" && !typing() && menu.hidden) {
    openChat();
    e.preventDefault();
    return;
  }
  if (!menu.hidden) return menuKey(e);
  // In a game that locks the mouse, Esc arrives as the lock's loss (below); a free cursor may be a mod's own window, which Esc closes first.
  if (e.code === "Escape" && inputFree()) return openMenu();
  if (e.code === "KeyT" && !typing() && menu.hidden) return startTalking();
  if (e.code === "KeyE" && !e.repeat && !typing() && menu.hidden && !panel) runAction();
  if (typing() || panel || !menu.hidden || picker.isOpen()) return;
  keys.add(e.code);
  if (!e.repeat) pressed[e.code] = (pressed[e.code] ?? 0) + 1;
});
addEventListener("keyup", (e: KeyboardEvent) => {
  if (e.code === "KeyT") stopTalking(true);
  keys.delete(e.code);
  replayKeys.delete(e.code);
});
addEventListener("blur", () => {
  keys.clear();
  releaseKeys();
  stopTalking(true);
});
chat.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === "Escape") stopTalking(e.key === "Enter" && !chat.value.trim());
  if (e.key === "Enter") {
    if (chat.value.trim()) send({ t: "chat", text: chat.value.trim() });
    chat.value = "";
  }
  if (e.key === "Enter" || e.key === "Escape") {
    chat.blur();
    chat.hidden = true;
    capture();
  }
  e.stopPropagation();
});
$("menu-button").onclick = () => openMenu();

type Builder = { state: "listening" | "working" | "offline"; task?: { title: string; status: string; percent?: number; state: "working" | "done" | "blocked" } };
const builderName = (name: string) => `${name}'s Claude`;
let claudes = new Map<string, Builder>();
/** Everyone sees what every Claude is building: a HUD line per busy Claude and the Builders tab. */
function showBuilders() {
  const busy = [...claudes].filter(([name, b]) => b.state === "working" && name !== me);
  $("builders").replaceChildren(
    ...busy.map(([name, { task }]) =>
      Object.assign(document.createElement("div"), {
        textContent: task?.state === "working" ? `${builderName(name)}: ${task.title}${task.percent === undefined ? "" : ` ${task.percent}%`}` : `${builderName(name)} is building…`,
      }),
    ),
  );
  const states = { working: "Working", listening: "Listening", offline: "Offline" };
  const rows = [...claudes].sort(([, a], [, b]) => Number(b.state === "working") - Number(a.state === "working"));
  $("menu-builders").replaceChildren(
    ...(rows.length
      ? rows.map(([name, b]) => {
          const li = document.createElement("li");
          li.className = `row ${b.task?.state ?? ""}`;
          li.innerHTML = `<div><b></b><span></span></div><p></p><div class="bar"><i></i></div>`;
          li.querySelector("b")!.textContent = builderName(name);
          li.querySelector("span")!.textContent = b.task ? `${b.task.state === "working" ? states[b.state] : b.task.state}${b.task.percent === undefined ? "" : ` · ${b.task.percent}%`}` : states[b.state];
          li.querySelector("p")!.textContent = b.task ? `${b.task.title}${b.task.status ? ` — ${b.task.status}` : ""}` : "No task posted yet.";
          li.querySelector<HTMLElement>(".bar i")!.style.width = `${b.task?.state === "done" ? 100 : (b.task?.percent ?? 0)}%`;
          if (b.task?.percent === undefined && b.task?.state !== "done") li.querySelector(".bar")!.remove();
          return li;
        })
      : [Object.assign(document.createElement("li"), { textContent: "No agent has connected yet." })]),
  );
}

/** What Claudes tell each other with say to "claudes": kept out of chat, readable in the Builders tab. */
function addTalk(from: string, text: string) {
  const li = document.createElement("li");
  li.append(Object.assign(document.createElement("b"), { textContent: from }), text);
  $("menu-talk").append(li);
  while ($("menu-talk").children.length > 50) $("menu-talk").firstElementChild!.remove();
  $("talk-count").textContent = String($("menu-talk").children.length);
}

const claudeLabels = { listening: "Agent listening", working: "Agent working…", offline: "Connect your agent" };
function showClaude(state: keyof typeof claudeLabels) {
  $("claude").textContent = claudeLabels[state];
  $("claude").dataset.state = state;
}
// A world whose host turned agents off has no prompt to hand out.
if (info.agents === false) {
  $("claude").hidden = true;
  $("agents-off").hidden = false;
  for (const el of all<HTMLElement>(".agents-on")) el.hidden = true;
}
$("claude").onclick = () => {
  if ($("claude").dataset.state !== "offline") return;
  void openMenu();
  openPage("claude");
};

$("menu-close").onclick = closeMenu;
/** Shows a page of the menu beside the rail, or with null only the rail. */
function showTab(tab: string | null) {
  const button = tab ? $("rail").querySelector<HTMLElement>(`[data-tab="${tab}"]`) : null;
  if (tab) send({ t: "act", what: "tab", detail: button?.textContent ?? tab });
  for (const b of $("rail").querySelectorAll<HTMLElement>("[data-tab]")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const s of $("pages").querySelectorAll<HTMLElement>("section[data-tab]")) s.hidden = s.dataset.tab !== tab;
  $("pages").hidden = !tab;
  menu.classList.toggle("paging", !!tab);
  $("page-title").textContent = button?.textContent ?? "";
  if (tab === "mods") refreshMenu();
  if (tab === "world") void showWorld();
}
/** Opens a page and moves the keyboard into it. */
function openPage(tab: string) {
  showTab(tab);
  $("pages").scrollTop = 0;
  const first = onPage($("pages").querySelector("section:not([hidden])")!, "button, input, select, textarea, a[href], [tabindex='0']").find((el) => el.getClientRects().length);
  (first ?? $("pages")).focus({ preventScroll: true });
}
function closePage() {
  const tab = $("rail").querySelector<HTMLElement>(".active");
  showTab(null);
  (tab ?? $("menu-close")).focus();
}
for (const b of $("rail").querySelectorAll<HTMLElement>("[data-tab]")) b.onclick = () => openPage(b.dataset.tab!);
$("page-back").onclick = closePage;
$("pages").tabIndex = -1;
/** Esc goes back a level and then resumes; right opens the entry on the rail, left goes back to it. */
function menuKey(e: KeyboardEvent) {
  const inPage = $("pages").contains(focused()) || ui.contains(focused());
  const field = focused()?.matches("input:not([type=range]), textarea, select, [contenteditable]");
  if (e.code === "Escape") {
    e.preventDefault();
    if (performance.now() - menuOpenedAt < 300) return;
    return $("pages").hidden ? closeMenu() : closePage();
  }
  if (e.code === "ArrowRight" && !inPage && (focused() as HTMLElement | null)?.dataset.tab) return openPage((focused() as HTMLElement).dataset.tab!);
  if (e.code === "ArrowLeft" && inPage && !field && !focused()?.matches("input[type=range]")) return closePage();
}

/** Cmd+K: every menu tab, and every button and setting inside one, searchable in one list. Buttons run straight away. */
type Command = { label: string; where: string; run(): void };
let commands: Command[] = [];
let shown: Command[] = [];
let picked = 0;
const textOf = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, " ").trim() ?? "";
function menuCommands(): Command[] {
  const list: Command[] = [];
  const open = (tab: string, el?: HTMLElement) => {
    if (menu.hidden) void openMenu();
    showTab(tab);
    el?.scrollIntoView({ block: "center" });
    el?.focus();
  };
  for (const b of $("rail").querySelectorAll<HTMLElement>("[data-tab]")) list.push({ label: textOf(b), where: "Menu", run: () => open(b.dataset.tab!) });
  for (const section of menu.querySelectorAll<HTMLElement>("section[data-tab]")) {
    const tab = section.dataset.tab!;
    const title = textOf($("rail").querySelector(`[data-tab="${CSS.escape(tab)}"]`));
    for (const el of onPage(section, "button, input, select, textarea")) {
      const hiddenIn = el.parentElement?.closest("[hidden]");
      if ((el as HTMLButtonElement).disabled || el.hidden || (hiddenIn && hiddenIn !== section && (section.contains(hiddenIn) || ui.contains(hiddenIn)))) continue;
      const heading = onPage(section, "h2, h3, b, label").filter((h) => h.getRootNode() === el.getRootNode() && h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && !h.contains(el)).pop();
      const own = el.tagName === "BUTTON" ? textOf(el) : textOf(el.closest("label")) || el.getAttribute("aria-label") || (el as HTMLInputElement).placeholder || textOf(heading);
      if (!own) continue;
      const context = textOf(heading) && textOf(heading) !== own ? `${title} · ${textOf(heading)}` : title;
      list.push({ label: own, where: context, run: el.tagName === "BUTTON" ? () => el.click() : () => open(tab, el) });
    }
  }
  for (const b of $("rail").querySelectorAll<HTMLElement>("button:not([data-tab])")) list.push({ label: textOf(b), where: "Menu", run: () => b.click() });
  list.push({ label: colliders ? "Hide colliders" : "Show colliders", where: "Debug", run: () => showColliders(!colliders) });
  for (const b of activeBindings()) list.push({ label: b.label, where: `Key ${keyLabel(b.code)} · ${b.mod.name}`, run: () => (press(b, true), press(b, false)) });
  return list;
}
function openPalette() {
  releaseKeys();
  commands = menuCommands();
  palette.hidden = false;
  toTop(palette);
  if (document.pointerLockElement) document.exitPointerLock();
  const input = $<HTMLInputElement>("palette-input");
  input.value = "";
  input.focus();
  filterPalette();
}
function closePalette() {
  palette.hidden = true;
  capture();
}
function filterPalette() {
  const words = $<HTMLInputElement>("palette-input").value.toLowerCase().split(/\s+/).filter(Boolean);
  const score = (c: Command) => (c.label.toLowerCase().startsWith(words[0] ?? "") ? 0 : 1);
  shown = commands.filter((c) => words.every((w) => `${c.label} ${c.where}`.toLowerCase().includes(w))).sort((a, b) => score(a) - score(b)).slice(0, 60);
  picked = 0;
  $("palette-empty").hidden = shown.length > 0;
  $("palette-list").replaceChildren(
    ...shown.map((c, i) => {
      const li = document.createElement("li");
      li.append(Object.assign(document.createElement("b"), { textContent: c.label }), Object.assign(document.createElement("span"), { textContent: c.where }));
      li.onmouseenter = () => markPicked(i);
      li.onclick = () => runPicked(i);
      return li;
    }),
  );
  markPicked(0);
}
function markPicked(i: number) {
  picked = i;
  $("palette-list").querySelectorAll("li").forEach((li, j) => li.classList.toggle("active", j === i));
  $("palette-list").children[i]?.scrollIntoView({ block: "nearest" });
}
function runPicked(i: number) {
  const command = shown[i];
  if (!command) return;
  palette.hidden = true;
  send({ t: "act", what: "palette", detail: `${command.where}: ${command.label}` });
  command.run();
  capture();
}
$("palette-input").oninput = filterPalette;
$("palette-input").addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    markPicked((picked + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % Math.max(1, shown.length));
  } else if (e.key === "Enter") runPicked(picked);
  else if (e.key === "Escape") closePalette();
  if (!((e.metaKey || e.ctrlKey) && e.code === "KeyK")) e.stopPropagation();
});
palette.onclick = (e) => e.target === palette && closePalette();
for (const keysList of $("howto").querySelectorAll(".keys")) $("help-keys").append(keysList.cloneNode(true));
/** Leaving closes this world: the host goes back to their main menu, anyone else to this world's join screen. */
let leaving = false;
/** The desktop app says when a newer release is out, and installs it when asked. */
const desktop = (window as { sandboxDesktop?: { update(): Promise<string | null>; onUpdate(fn: (version: string | null) => void): void; leave(): void } }).sandboxDesktop;
desktop?.onUpdate((version) => ($("menu-update").hidden = !version));
$("menu-update").onclick = async () => {
  const error = await desktop?.update();
  if (error) toast(error, "error");
};
/** In the app everyone leaves to its title screen; in a browser the host goes to their main menu. */
function leave() {
  leaving = true;
  socket?.close();
  if (desktop) return desktop.leave();
  if (hosting) return location.assign("menu");
  history.replaceState(null, "", `${origin}/#left`);
  location.reload();
}
$("leave").onclick = leave;

/** The host's own world: rewind it to a saved moment, export it, or stop hosting it. */
if (hostsThisWorld) {
  $("rail").querySelector<HTMLElement>("[data-tab=world]")!.hidden = false;
  $("world-saved").textContent = info.name;
}
async function showWorld() {
  $("world-stop").textContent = "Stop hosting";
  const s = await (await hostMenu("state")).json();
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  $("world-snapshots").replaceChildren(
    ...(s.running?.snapshots ?? []).map((at: number) => {
      const rewind = Object.assign(document.createElement("button"), { textContent: "Rewind" });
      rewind.onclick = async () => {
        if (rewind.textContent === "Rewind") return void (rewind.textContent = `Rewind to ${time(at)}?`);
        const res = await hostMenu("rewind", { at });
        if (!res.ok) toast((await res.json()).error, "error");
      };
      const row = Object.assign(document.createElement("div"), { className: "copy-row" });
      row.append(Object.assign(document.createElement("span"), { textContent: time(at) }), Object.assign(document.createElement("code"), { textContent: "Saved moment" }), rewind);
      return row;
    }),
  );
}
$("world-export").onclick = async () => {
  $("world-export").textContent = "Exporting…";
  const res = await hostMenu("export", { id: info.id });
  $("world-export").textContent = "Export";
  if (!res.ok) return toast((await res.json()).error, "error");
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(await res.blob()), download: res.headers.get("content-disposition")?.match(/filename="(.+)"/)?.[1] ?? "world.zip" });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
};
$("world-stop").onclick = async () => {
  if ($("world-stop").textContent === "Stop hosting") return void ($("world-stop").textContent = "Stop for everyone?");
  leaving = true;
  await hostMenu("stop", {});
  leave();
};

/** The host's speech key, kept by their launcher and shown only by its provider and last characters. */
$("voice-field").hidden = $("voice-where").hidden = !hosting;
$<HTMLInputElement>("voice-key").placeholder = hosting?.voiceKey ?? "Paste a speech key";
if (hosting)
  $("voice-where").replaceChildren(
    "Paste a speech key from ",
    ...hosting.voiceProviders.flatMap((p: { name: string; keys: string; free: boolean }, i: number, all: unknown[]) => [
      i ? (i === all.length - 1 ? " or " : ", ") : "",
      Object.assign(document.createElement("a"), { href: p.keys, target: "_blank", rel: "noreferrer", textContent: p.name }),
      p.free ? " (free)" : "",
    ]),
    ".",
  );
$("voice-key").onchange = async () => {
  const field = $<HTMLInputElement>("voice-key");
  const res = await hostMenu("voice", { key: field.value });
  const data = await res.json().catch(() => ({ error: "The voice key wasn't saved. Try again." }));
  if (!res.ok) return toast(data.error, "error");
  field.value = "";
  field.placeholder = data.voiceKey ?? "Paste a speech key";
  toast(data.voiceKey ? "Voice is on" : "Voice is off");
};

/** Master volume, remembered on this device. */
function setVolume(percent: number) {
  const v = Math.max(0, Math.min(100, Math.round(percent)));
  audio.output.gain.value = v / 100;
  $<HTMLInputElement>("volume").value = $<HTMLInputElement>("volume-exact").value = String(v);
  try {
    localStorage.setItem("sandbox-volume", String(v));
  } catch {}
}
let savedVolume = 100;
try {
  savedVolume = Number(localStorage.getItem("sandbox-volume") ?? 100);
} catch {}
setVolume(savedVolume);
$("volume").oninput = () => setVolume(Number($<HTMLInputElement>("volume").value));
$("volume-exact").onchange = () => setVolume(Number($<HTMLInputElement>("volume-exact").value));

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sandbox";

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
/** One prompt for any coding agent with a shell: it installs this world's command, signed with this player's key, then plays. */
function connectPrompt() {
  const base = link?.split("/#")[0] ?? origin;
  const bin = `~/.local/bin/${slug(world)}`;
  const install = `mkdir -p ~/.local/bin && curl -fsS -H ${shellQuote(`Authorization: Bearer ${key}`)} ${shellQuote(`${base}/cli?name=${slug(world)}&url=${encodeURIComponent(base)}`)} -o ${bin} && chmod +x ${bin}`;
  return `First install the command for our game by running \`${install}\`. Then run \`${bin}\` alone to list its tools, call one as \`${bin} <tool> name=value\`, and give wait_for_chat calls a shell timeout of at least 300 seconds. We are playing ${world} together right now: a live multiplayer game my friends and I build while we play it, each with our own coding agent. I am ${me} in the game. Anything you reload goes live for every player at once, so make it one coherent game: extend what the others built instead of building it again, and see a thing work before you tell me it does. Start with status and read GUIDE.md, then say in a line or two what the world has and one thing you could build. From then on I talk to you only through the in-game chat, where my voice is transcribed too when I hold T: act when I ask for something or clearly want a change, not on every word. Then loop forever: wait_for_chat seconds=240, get what I (${me}) ask for built, say what is done in a line, and wait_for_chat again. If you can start subagents or background tasks, be the orchestrator and never build or test yourself: give each request, or each part of a big one, to its own subagent owning its own mod, which builds, reloads and checks it in play, keep calling wait_for_chat while they work, and say only what they saw working (GUIDE.md, Subagents). Nothing ever arrives in this terminal, so never end your turn.`;
}

function showInvite() {
  $("invite-link").textContent = link ?? `${origin}/#invite=${invite}`;
  $("invite-wifi").hidden = !wifiOnly;
}

let menuOpenedAt = 0;
async function openMenu() {
  send({ t: "act", what: "menu" });
  keys.clear();
  leaveReplay();
  releaseKeys();
  const wasHidden = menu.hidden;
  showMenu(true);
  menuOpenedAt = performance.now();
  if (wasHidden) {
    showTab(null);
    $("menu-close").focus({ preventScroll: true });
  }
  if (document.pointerLockElement) document.exitPointerLock();
  $("menu-world").textContent = world;
  $("claude-prompt").textContent = connectPrompt();
  showBuilders();
  await refreshMenu();
}

const myVotes = new Map<string, string>();
async function refreshMenu() {
  const status = await (await fetch("/api/status", { headers: { authorization: `Bearer ${key}` } })).json();
  $("menu-players").replaceChildren(...status.online.map((p: string) => Object.assign(document.createElement("li"), { textContent: p === me ? `${p} (you)` : p })));
  // The rebuild keeps the keyboard on its vote button, or lands it on the first when the page just opened.
  const voting = [...$("menu-mods").querySelectorAll("button")].indexOf(focused() as HTMLButtonElement);
  const landing = voting < 0 && focused() === $("pages");
  $("menu-mods").replaceChildren(
    ...(status.mods.length
      ? status.mods.map((m: any) => {
          const li = document.createElement("li");
          li.className = "row";
          li.innerHTML = `<div><b></b><span></span></div><p></p><div class="votes"><button data-kind="love">Love it</button><button data-kind="undo">Vote to undo</button></div>`;
          li.querySelector("b")!.textContent = m.about?.title && m.about.title.toLowerCase() !== m.name ? `${m.name} · ${m.about.title}` : m.name;
          li.querySelector("span")!.textContent = `by ${m.author} · v${m.version}`;
          if (m.about?.text) li.querySelector("p")!.textContent = m.about.text;
          else li.querySelector("p")!.remove();
          const [love, undo] = li.querySelectorAll("button");
          love!.textContent += m.love ? ` ${m.love}` : "";
          undo!.textContent += ` ${m.undo}/${status.undoNeeded}`;
          for (const b of [love!, undo!]) {
            b.disabled = m.author === me;
            b.classList.toggle("picked", myVotes.get(m.name) === `${m.version}:${b.dataset.kind}`);
            b.onclick = () => {
              myVotes.set(m.name, `${m.version}:${b.dataset.kind}`);
              send({ t: "react", mod: m.name, kind: b.dataset.kind });
            };
          }
          return li;
        })
      : [Object.assign(document.createElement("li"), { textContent: "No mods yet" })]),
  );
  if (voting >= 0 || landing) $("menu-mods").querySelectorAll("button")[Math.max(voting, 0)]?.focus();
}

for (const button of all<HTMLButtonElement>("[data-copy]"))
  button.onclick = async () => {
    const code = $(button.dataset.copy!);
    // Plain-http LAN links have no clipboard API, and an unfocused page is refused it.
    if (!(await navigator.clipboard?.writeText(code.textContent!).then(() => true, () => false))) {
      getSelection()!.selectAllChildren(code);
      document.execCommand("copy");
    }
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1500);
  };

// ---------- loop ----------
const emptyHint = $("empty");
let welcomedAt = Infinity;
let last = performance.now();
const target = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  // The live view behind the join screen draws about 30 frames a second at no more than a pixel per CSS pixel, whatever mods ask for.
  if (spectator && now - last < 32) return;
  if (spectator && renderer.getPixelRatio() > 1) renderer.setPixelRatio(1);
  const dt = Math.min((now - last) / 1000, 0.1);
  stats.frames.push(now - last);
  last = now;
  renderer.info.reset();
  const blend = 1 - Math.exp(-dt * 15);
  for (const [id, obj] of objects) {
    const e = entities.get(id);
    if (!e?.pos || obj.userData.manual) continue;
    obj.position.lerp(target.fromArray(e.pos), blend);
    if (e.rot) obj.rotation.set(e.rot[0] ?? 0, e.rot[1] ?? 0, e.rot[2] ?? 0);
  }
  for (const m of ordered) call(m, "frame", dt);
  showAction();
  if (replay) advance(dt, now);
  if (replay) film(dt, now);
  if (spectator && view === camera && screen.scene !== false) driftCamera(dt, now);
  shakeCamera(dt);
  updateColliders(now);
  const drawStart = performance.now();
  if (screen.scene !== false) draw(dt);
  view.position.sub(shakeOffset);
  if (heldMaterials) for (const m of heldMaterials.splice(0)) disposeMaterial.call(m);
  heldMaterials = null;
  stats.drawMs += performance.now() - drawStart;
  stats.loopMs += performance.now() - now;
  stats.calls += renderer.info.render.calls;
  stats.triangles += renderer.info.render.triangles;
  const hideHint = entities.size > 0 || mods.size > 0 || now - welcomedAt < 1000;
  if (emptyHint.hidden !== hideHint) emptyHint.hidden = hideHint;
});

function draw(dt: number) {
  let next = () => renderer.render(scene, view);
  for (const m of ordered) {
    if (!m.mod.render) continue;
    const inner = next;
    next = () => call(m, "render", inner, dt);
  }
  next();
}

// ---------- debugging for the Claudes: the perf and logs tools ----------
const stats = { frames: [] as number[], loopMs: 0, drawMs: 0, calls: 0, triangles: 0, bytes: 0, ping: 0 };
/** Key presses since the last report, so the record shows which controls players use. */
let pressed: Record<string, number> = {};
const gl = renderer.getContext();
const gpu = gl.getExtension("WEBGL_debug_renderer_info");
const gpuName = gpu ? gl.getParameter(gpu.UNMASKED_RENDERER_WEBGL) : "unknown";
let reportedAt = performance.now();
setInterval(() => {
  const now = performance.now();
  const n = stats.frames.length || 1;
  const sorted = [...stats.frames].sort((a, b) => a - b);
  const r = (v: number) => Math.round(v * 100) / 100;
  send({
    t: "perf",
    at: now,
    fps: Math.round((stats.frames.length * 1000) / (now - reportedAt)),
    slowestFrameMs: r(sorted.at(-1) ?? 0),
    p95FrameMs: r(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    msPerFrame: { engineAndMods: r(stats.loopMs / n), drawing: r(stats.drawMs / n) },
    modsMsPerFrame: Object.fromEntries(ordered.filter((m) => m.ms).sort((a, b) => b.ms - a.ms).map((m) => [m.name, r(m.ms / n)])),
    drawCallsPerFrame: Math.round(stats.calls / n),
    trianglesPerFrame: Math.round(stats.triangles / n),
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    geometriesByMod: topMade(made.geometries),
    texturesByMod: topMade(made.textures),
    ...sceneCost(),
    solidWithoutModel: invisibleWalls(),
    entities: entities.size,
    pingMs: stats.ping,
    downloadKBps: r(stats.bytes / 1024 / ((now - reportedAt) / 1000)),
    heapMB: Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1048576) || undefined,
    screen: `${renderer.domElement.width}x${renderer.domElement.height} at pixel ratio ${renderer.getPixelRatio()}`,
    gpu: gpuName,
    hidden: document.hidden || undefined,
    pressed,
  });
  pressed = {};
  for (const m of ordered) m.ms = 0;
  Object.assign(stats, { frames: [], loopMs: 0, drawMs: 0, calls: 0, triangles: 0, bytes: 0 });
  reportedAt = now;
  forwarded = 0;
}, 2000);

// Tags objects with the mod that added them, so perf can name who owns the heavy ones: the mod whose hook is running, or for what a mod's timer or promise adds straight to the scene, the mod in the call stack.
const add = THREE.Object3D.prototype.add;
THREE.Object3D.prototype.add = function (...objects) {
  if (running || this === scene) for (const o of objects) o.userData.mod ??= running?.name ?? modOf(new Error().stack);
  return add.apply(this, objects);
};
/** The solid entities drawn as wireframes because nothing else draws them, by the mod that made them. */
function invisibleWalls() {
  const byMod: Record<string, number> = {};
  for (const obj of objects.values()) if (obj.userData.wall) byMod[obj.userData.wall] = (byMod[obj.userData.wall] ?? 0) + 1;
  return { count: Object.values(byMod).reduce((a, b) => a + b, 0), byMod };
}

function sceneCost() {
  let sceneObjects = 0;
  const heavy: { mod: string; object: string; triangles: number; shadow: boolean }[] = [];
  const shadowLights: string[] = [];
  scene.traverse((o: any) => {
    sceneObjects++;
    let mod = "engine";
    for (let p = o; p; p = p.parent) if (p.userData.mod) { mod = p.userData.mod; break; }
    if (o.isLight && o.castShadow && o.visible) shadowLights.push(`${mod}: ${o.type} ${o.shadow.mapSize.x}px`);
    if (!o.isMesh && !o.isPoints && !o.isLine) return;
    const g = o.geometry;
    const triangles = Math.round(((g.index?.count ?? g.attributes.position?.count ?? 0) / 3) * (o.isInstancedMesh ? o.count : 1));
    heavy.push({ mod, object: `${o.type}${o.name ? ` "${o.name}"` : ""}${o.isInstancedMesh ? ` x${o.count}` : ""}`, triangles, shadow: !!o.castShadow });
  });
  const byMod: Record<string, number> = {};
  for (const h of heavy) byMod[h.mod] = (byMod[h.mod] ?? 0) + h.triangles;
  return {
    sceneObjects,
    trianglesByMod: Object.fromEntries(Object.entries(byMod).sort((a, b) => b[1] - a[1]).slice(0, 10)),
    heaviestObjects: heavy.sort((a, b) => b.triangles - a.triangles).slice(0, 8),
    shadowLights,
    renderHooks: ordered.filter((m) => m.mod.render).map((m) => m.name),
  };
}

let forwarded = 0;
const modOf = (stack = "") => stack.match(/\/build\/([^/]+)\/[^/]+\/client\//)?.[1];
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: any[]) => {
    original(...args);
    if (forwarded >= 30) return;
    const mod = modOf(new Error().stack);
    if (!mod) return;
    forwarded++;
    send({ t: "log", mod, level, text: args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack : JSON.stringify(a) ?? String(a))).join(" ") });
  };
}
addEventListener("error", (e: ErrorEvent) => {
  const mod = modOf(e.error?.stack ?? e.filename);
  if (mod && ++forwarded <= 30) send({ t: "error", mod, text: `uncaught: ${e.error?.stack ?? e.message}` });
});
addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  const mod = modOf(e.reason?.stack);
  if (mod && ++forwarded <= 30) send({ t: "error", mod, text: `unhandled rejection: ${e.reason?.stack ?? e.reason}` });
});

if (!/Mac|iPhone|iPad/.test(navigator.platform)) for (const k of all(".cmd")) k.textContent = "Ctrl";
if (watching) {
  $("hud").hidden = false;
  $("status").hidden = true;
  if (!(await playTimelapse())) setTimeout(() => location.assign("menu"), 4000);
} else {
  await start();
  $("hud").hidden = false;
  $("howto-world").textContent = info.name;
  howto.hidden = false;
  stopSpectating();
  connect();
}
