import { toCanvas } from "html-to-image";
import * as THREE from "three";
import type { ClientCtx, ClientHooks, ClientMod, Entity } from "../api";
import { PhysicsIndex } from "../physics";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const hashParams = new URLSearchParams(location.hash.slice(1));

// Through the relay the game lives at /r/<room>/; its own requests reach the room by cookie, but links and Claude need the full address.
const origin = location.origin + (location.pathname.match(/^\/r\/[a-z0-9-]+/)?.[0] ?? "");
const info = await (await fetch("/api/info")).json();
const keyName = `sandbox-key:${info.id}`;
let key = hashParams.get("key") ?? localStorage.getItem(keyName);
let me = "";
let world = "";
let invite = "";
let publicUrl: string | null = null;

async function join(body: object) {
  const res = await fetch("/api/join", { method: "POST", body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  localStorage.setItem(keyName, data.key);
  localStorage.setItem("sandbox-name", data.name);
  key = data.key;
  me = data.name;
  history.replaceState(null, "", "/");
}

async function start() {
  if (key) {
    try {
      return await join({ key });
    } catch {
      localStorage.removeItem(keyName);
    }
  }
  $("join-world").textContent = info.name;
  $("join-online").textContent = info.online ? `${info.online} playing now` : "Nobody is here yet";
  $("join").hidden = false;
  if (!hashParams.get("invite")) $("join-error").textContent = "Ask the host for an invite link to join.";
  $<HTMLInputElement>("join-name").value = localStorage.getItem("sandbox-name") ?? "";
  $("join-name").focus();
  await new Promise<void>((resolve) => {
    $("join-form").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await join({ invite: hashParams.get("invite"), name: $<HTMLInputElement>("join-name").value });
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

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

// ---------- entities ----------
const entities = new Map<number, Entity>();
const objects = new Map<number, THREE.Object3D>();
const looks = new Map<number, string>();
const custom = new Set<THREE.Object3D>();
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
    default:
      return new THREE.BoxGeometry(x, y, z);
  }
}

function labelSprite(text: string) {
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
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.scale.set(canvas.width / 128, 0.5, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function build(id: number, e: Entity) {
  for (const m of [...ordered].reverse()) {
    if (!m.mod.object) continue;
    const made: THREE.Object3D | null | undefined = call(m, "object", id, e);
    if (made) {
      custom.add(made);
      return made;
    }
  }
  return defaultObject(e);
}

function defaultObject(e: Entity) {
  const group = new THREE.Group();
  if (e.mesh && e.mesh.opacity !== 0) {
    const size = typeof e.mesh.size === "number" ? [e.mesh.size] : (e.mesh.size ?? [1]);
    const material = new THREE.MeshStandardMaterial({
      color: e.mesh.color ?? "#cccccc",
      emissive: e.mesh.emissive ?? "#000000",
      roughness: e.mesh.roughness ?? 0.8,
      metalness: e.mesh.metalness ?? 0,
      transparent: e.mesh.opacity !== undefined,
      opacity: e.mesh.opacity ?? 1,
    });
    const mesh = new THREE.Mesh(sharedGeometry(e.mesh.shape ?? "box", size), material);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (e.label) {
    const sprite = labelSprite(String(e.label));
    const height = Array.isArray(e.mesh?.size) ? (e.mesh.size[1] ?? 1) : (e.mesh?.size ?? 1);
    sprite.position.y = height / 2 + 0.6;
    group.add(sprite);
  }
  return group;
}

// Objects from a mod's object hook may share geometry and materials, so only the mod may free them.
function dispose(obj: THREE.Object3D) {
  scene.remove(obj);
  if (custom.delete(obj)) return;
  obj.traverse((o: any) => {
    if (o.geometry) releaseGeometry(o.geometry);
    o.material?.map?.dispose();
    o.material?.dispose();
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
  const look = JSON.stringify([e.mesh, e.label, e.look]);
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

function rebuildAll() {
  for (const [id, e] of entities) {
    looks.delete(id);
    syncObject(id, e, true);
  }
}

type Tick = { reset?: true; set: Record<string, Entity>; unset: Record<string, string[]>; removed: number[]; events?: { from: string; name: string; data: any }[] };

function applyTick({ reset, set, unset, removed, events }: Tick) {
  if (reset) for (const id of [...entities.keys()]) if (!(id in set)) removed.push(id);
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
    syncObject(id, undefined, false);
    physics.update(id, undefined);
  }
  for (const ev of events ?? []) for (const m of ordered) if (m.mod.event) call(m, "event", ev.name, ev.data, ev.from);
}

// ---------- mods ----------
type Action = Parameters<ClientCtx["interact"]>[0];
type Ground = (x: number, z: number, fromY: number) => number | null;
type Loaded = { name: string; url: string; mod: ClientMod; ctx: ClientCtx; errors: number; ms: number; owned: HTMLElement[]; actions: Set<Action>; grounds: Set<Ground> };
const mods = new Map<string, Loaded>();
let ordered: Loaded[] = [];
const keys = new Set<string>();
let socket: WebSocket | null = null;
const send = (msg: object) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(msg));

function reorder() {
  ordered = [...mods.values()].sort((a, b) => (a.mod.order ?? 0) - (b.mod.order ?? 0) || a.name.localeCompare(b.name));
  physics.grounds = ordered.flatMap((m) => [...m.grounds]);
}

function guarded<T>(m: Loaded, label: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e: any) {
    console.error(`[${m.name}] ${label}`, e);
    send({ t: "error", mod: m.name, text: `${label}: ${e?.stack ?? e}` });
    if (++m.errors >= 10 && mods.get(m.name) === m) {
      mods.delete(m.name);
      reorder();
      toast(`${m.name} kept crashing in your game and was switched off`, "error");
    }
  }
}

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

async function loadMod(name: string, url: string | null) {
  const old = mods.get(name);
  if (old?.url === url) return;
  let mod: ClientMod | null = null;
  if (url) {
    try {
      mod = (await import(url)).default ?? {};
    } catch (e: any) {
      send({ t: "error", mod: name, text: `import: ${e?.stack ?? e}` });
      return;
    }
  }
  if (old) {
    call(old, "dispose");
    for (const el of old.owned) el.remove();
    mods.delete(name);
    pruneTabs();
  }
  if (!mod || !url) {
    reorder();
    return rebuildAll();
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
    playerId: me,
    keys,
    send: (msg) => send({ t: "m", mod: name, msg }),
    use,
    has,
    asset: (file) => `/assets/${file.includes("/") ? file : `${name}/${file}`}`,
    menuTab: (title) => {
      const block = document.createElement("div");
      menuSection(title).append(block);
      loaded.owned.push(block);
      return block;
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
  };
  const loaded: Loaded = { name, url, mod, ctx, errors: 0, ms: 0, owned: [], actions: new Set(), grounds: new Set() };
  mods.set(name, loaded);
  reorder();
  call(loaded, "init");
  if (mod.object || old?.mod.object) rebuildAll();
}

/** The section of the menu tab with this title; mods share tabs by title, and a tab no mod fills any more goes away. */
const CORE_TABS = ["game", "builders", "mods", "help"];
let tabSeq = 0;
function menuSection(title: string) {
  let button = [...$("tabs").querySelectorAll<HTMLElement>("button")].find((b) => b.textContent!.trim().toLowerCase() === title.trim().toLowerCase());
  if (!button) {
    const id = `tab-${++tabSeq}`;
    button = Object.assign(document.createElement("button"), { textContent: title });
    const section = document.createElement("section");
    button.dataset.tab = section.dataset.tab = id;
    section.hidden = true;
    button.onclick = () => showTab(id);
    $("tabs").insertBefore(button, $("tabs").querySelector("[data-tab=help]"));
    $("menu").querySelector("section[data-tab=help]")!.before(section);
  }
  return $("menu").querySelector<HTMLElement>(`section[data-tab="${button.dataset.tab}"]`)!;
}
function pruneTabs() {
  for (const section of $("menu").querySelectorAll<HTMLElement>("section[data-tab]")) {
    const tab = section.dataset.tab!;
    if (CORE_TABS.includes(tab) || section.childElementCount) continue;
    const button = $("tabs").querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (button?.classList.contains("active")) showTab("game");
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
  try {
    near.action.run();
  } catch (e: any) {
    send({ t: "error", mod: near.mod.name, text: `interact run(): ${e?.stack ?? e}` });
  }
}
function showAction() {
  let near = menu.hidden && palette.hidden ? nearestAction() : null;
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

// ---------- network ----------
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
        publicUrl = msg.publicUrl;
        voiceAvailable = msg.voice;
        showMic();
        me = msg.playerId;
        $("world-name").textContent = world;
        $("rules").textContent = msg.rules === "additive" ? "additive" : "open";
        $("status").hidden = true;
        welcomedAt = performance.now();
        showClaude(msg.claudes[me]?.state ?? "offline");
        claudes = new Map(Object.entries(msg.claudes));
        showBuilders();
        $("menu-talk").replaceChildren();
        for (const line of msg.talk) addTalk(line.from, line.text);
        const wanted = new Map<string, string>(msg.mods.map((m: any) => [m.name, m.url]));
        for (const name of mods.keys()) if (!wanted.has(name)) await loadMod(name, null);
        for (const [name, url] of wanted) await loadMod(name, url);
        for (const f of msg.feed) addLine(f.text, f.kind);
        return;
      }
      case "public":
        publicUrl = msg.url;
        return;
      case "claude":
        if (msg.name === me) showClaude(msg.state);
        claudes.set(msg.name, { state: msg.state, task: msg.task });
        return showBuilders();
      case "tick":
        return replaying || applyTick(msg);
      case "mod":
        return loadMod(msg.name, msg.url);
      case "shot":
        return send({ t: "shot", id: msg.id, data: await screenshot() });
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
        return addLine(`${msg.from}${msg.spoken ? " (voice)" : ""}: ${msg.text}`, msg.from.endsWith("'s Claude") || msg.from === "Game master" ? "claude" : msg.spoken ? "chat spoken" : "chat");
      case "talk":
        return addTalk(msg.from, msg.text);
    }
  };
  ws.onclose = (e) => {
    $("status").hidden = false;
    if (e.code === 4000) {
      $("status").textContent = "You opened the game in another tab.";
      return;
    }
    if (e.code === 4001) return location.reload();
    if (e.code === 4002) {
      $("status").textContent = "The host removed you from this world.";
      return;
    }
    $("status").textContent = "Reconnecting…";
    setTimeout(connect, 1000);
  };
}

/** The 3D view with every HTML overlay (engine HUD and mod UI) drawn on top, as base64 JPEG. */
async function screenshot() {
  draw(0);
  const scene3d = new Image();
  scene3d.src = renderer.domElement.toDataURL("image/png");
  const [overlay] = await Promise.all([
    toCanvas(document.body, { filter: (node) => node !== renderer.domElement, skipFonts: true, pixelRatio: 1, style: { background: "transparent" } }),
    scene3d.decode(),
  ]);
  const out = Object.assign(document.createElement("canvas"), { width: innerWidth, height: innerHeight });
  const g = out.getContext("2d")!;
  g.drawImage(scene3d, 0, 0, innerWidth, innerHeight);
  g.drawImage(overlay, 0, 0, innerWidth, innerHeight);
  return out.toDataURL("image/jpeg", 0.8).split(",")[1]!;
}

// ---------- HUD ----------
function addLine(text: string, kind = "info") {
  const line = document.createElement("div");
  line.className = `line ${kind}`;
  line.textContent = text;
  $("feed").append(line);
  while ($("feed").children.length > 40) $("feed").firstElementChild!.remove();
  $("feed").scrollTop = 1e9;
  return line;
}

/** After a mod arrives, players have 30 s to love it or vote it out. */
let reacting = "";
let reactTimer: ReturnType<typeof setTimeout> | undefined;
function askReaction(a: { mod: string; title: string; color: string }) {
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

/** Replays the last three hours from moments recorded every two seconds, then returns to the live world. */
let replaying = false;
let orbit = 30;
$("timelapse").onclick = async () => {
  closeMenu();
  const frames: (Tick & { at: number })[] = await (await fetch("/api/timelapse", { headers: { authorization: `Bearer ${key}` } })).json();
  if (!frames.length) return toast("Nothing to replay yet: the world records a moment every two seconds.");
  replaying = true;
  $("replay").hidden = false;
  const step = Math.min(400, Math.max(50, 40_000 / frames.length));
  for (const f of frames) {
    if (!replaying) break;
    $("replay-time").textContent = new Date(f.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    applyTick(f);
    const spots = [...entities.values()].flatMap((e) => (Array.isArray(e.pos) ? [Math.hypot(e.pos[0] ?? 0, e.pos[2] ?? 0)] : []));
    orbit = Math.min(150, Math.max(20, spots.sort((a, b) => a - b)[Math.floor(spots.length * 0.9)] ?? 20));
    await new Promise((r) => setTimeout(r, step));
  }
  replaying = false;
  $("replay").hidden = true;
  send({ t: "resync" });
};

const banners: { mod: string; by: string; title: string; text: string; color: string }[] = [];
function nextBanner() {
  const el = $("announce");
  const a = el.hidden && banners.shift();
  if (!a) return;
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
  setTimeout(() => el.remove(), 5000);
}

const chat = $<HTMLInputElement>("chat");
const menu = $("menu");
const howto = $("howto");
const palette = $("palette");
const typing = () => document.activeElement instanceof HTMLInputElement;

/** During play the mouse steers the camera; the cursor is free only while chat, the menu or an overlay is open. */
function capture() {
  if (!document.body.classList.contains("touch") && menu.hidden && chat.hidden && howto.hidden && palette.hidden && !document.pointerLockElement) renderer.domElement.requestPointerLock();
}
renderer.domElement.addEventListener("click", capture);
const ideas = ["add coins that respawn and a scoreboard", "make the floor lava every 30 seconds", "give me a grappling hook", "spawn a boss that chases whoever is winning", "let us build with blocks", "add a race track with a timer", "make me tiny and everyone else huge"];
function openChat() {
  chat.placeholder = `Chat, or ask your Claude: "${ideas[Math.floor(Math.random() * ideas.length)]}"`;
  chat.hidden = false;
  chat.focus();
  startTalking();
  if (document.pointerLockElement) document.exitPointerLock();
}
function closeMenu() {
  menu.hidden = true;
  capture();
}
function play() {
  howto.hidden = true;
  capture();
}

/** Push to talk: hold T (or the mic button) and the phrase goes to chat, transcribed by the host, so everyone and every Claude hears it. */
let voiceAvailable = false;
let micStream: Promise<MediaStream> | null = null;
let talking: { recorder: Promise<MediaRecorder> } | null = null;
function startTalking() {
  if (!voiceAvailable || talking) return;
  // The stream stays open after the first press so later presses record from the first word.
  micStream ??= navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const recorder = micStream.then((stream) => {
    const r = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => chunks.push(e.data);
    const began = performance.now();
    // Presses shorter than 300 ms of actual recording are accidental taps, and a press released before the mic was ready recorded nothing.
    r.onstop = () => {
      const audio = new Blob(chunks, { type: r.mimeType });
      if (audio.size && performance.now() - began > 300) void fetch("/api/voice", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: audio });
    };
    r.start();
    return r;
  });
  recorder.catch(() => {
    micStream = null;
    toast("The microphone is blocked. Allow it in the browser's address bar, then try again.", "error");
  });
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
function showMic() {
  $("mic").textContent = !voiceAvailable ? "No voice here" : talking ? "Talking" : matchMedia("(pointer: coarse)").matches ? "Hold to talk" : "Hold T to talk";
  $("mic").dataset.state = !voiceAvailable ? "none" : talking ? "on" : "off";
}
$("mic").onpointerdown = startTalking;
$("mic").onpointerup = $("mic").onpointerleave = () => stopTalking(true);
showMic();
$("howto-play").onclick = play;

addEventListener("keydown", (e: KeyboardEvent) => {
  if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") {
    e.preventDefault();
    return palette.hidden ? openPalette() : closePalette();
  }
  if (!howto.hidden) {
    if (e.code === "Enter" || e.code === "Space") play();
    return;
  }
  if ((e.code === "Digit1" || e.code === "Digit2") && !typing() && menu.hidden && !$("react").hidden) {
    react(e.code === "Digit1" ? "love" : "undo");
    return;
  }
  if (e.code === "Enter" && !typing() && menu.hidden) {
    openChat();
    e.preventDefault();
    return;
  }
  // Only Tab opens the game menu, so Esc and every other key stay free for mods.
  if (e.code === "Tab" && !typing()) {
    e.preventDefault();
    return menu.hidden ? openMenu() : closeMenu();
  }
  if (e.code === "Escape" && !typing() && !menu.hidden) return closeMenu();
  if (e.code === "KeyT" && !typing() && menu.hidden) return startTalking();
  if (e.code === "KeyE" && !e.repeat && !typing() && menu.hidden) runAction();
  if (!typing()) keys.add(e.code);
});
addEventListener("keyup", (e: KeyboardEvent) => {
  if (e.code === "KeyT") stopTalking(true);
  keys.delete(e.code);
});
addEventListener("blur", () => {
  keys.clear();
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
const GAME_MASTER = "gamemaster";
const builderName = (name: string) => (name === GAME_MASTER ? "Game master" : `${name}'s Claude`);
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
      : [Object.assign(document.createElement("li"), { textContent: "No Claude has connected yet." })]),
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

const claudeLabels = { listening: "Claude listening", working: "Claude working…", offline: "Connect Claude" };
function showClaude(state: keyof typeof claudeLabels) {
  $("claude").textContent = claudeLabels[state];
  $("claude").dataset.state = state;
}
$("claude").onclick = () => $("claude").dataset.state === "offline" && openMenu();

// Touch screens drive the same key codes as a keyboard, so every mod that reads ctx.keys works on phones.
function enableTouch() {
  document.body.classList.add("touch");
  $("stick").hidden = $("jump").hidden = false;
  $("menu-button").textContent = "Menu";
  $("hint").textContent = "Chat";
  $("hint").onclick = openChat;
  const stick = $("stick");
  const knob = stick.firstElementChild as HTMLElement;
  const steer = (e: PointerEvent) => {
    const box = stick.getBoundingClientRect();
    let x = (e.clientX - box.left - box.width / 2) / (box.width / 2);
    let y = (e.clientY - box.top - box.height / 2) / (box.height / 2);
    const len = Math.hypot(x, y);
    if (len > 1) [x, y] = [x / len, y / len];
    knob.style.translate = `${x * 40}px ${y * 40}px`;
    for (const [code, on] of [["KeyW", y < -0.35], ["KeyS", y > 0.35], ["KeyA", x < -0.35], ["KeyD", x > 0.35]] as const) on ? keys.add(code) : keys.delete(code);
  };
  const release = () => {
    knob.style.translate = "";
    for (const code of ["KeyW", "KeyS", "KeyA", "KeyD"]) keys.delete(code);
  };
  stick.onpointerdown = (e) => {
    stick.setPointerCapture(e.pointerId);
    steer(e);
  };
  stick.onpointermove = (e) => stick.hasPointerCapture(e.pointerId) && steer(e);
  stick.onpointerup = stick.onpointercancel = release;
  const jump = $("jump");
  jump.onpointerdown = (e) => {
    jump.setPointerCapture(e.pointerId);
    keys.add("Space");
  };
  jump.onpointerup = jump.onpointercancel = () => keys.delete("Space");
}
if (matchMedia("(pointer: coarse)").matches) enableTouch();
else addEventListener("touchstart", enableTouch, { once: true });
$("menu-close").onclick = closeMenu;
function showTab(tab: string) {
  for (const el of $("menu").querySelectorAll<HTMLElement>("[data-tab]")) {
    if (el.tagName === "BUTTON") el.classList.toggle("active", el.dataset.tab === tab);
    else el.hidden = el.dataset.tab !== tab;
  }
  if (tab === "mods") refreshMenu();
}
for (const b of $("tabs").querySelectorAll<HTMLElement>("button")) b.onclick = () => showTab(b.dataset.tab!);
$("tabs").addEventListener("wheel", (e) => {
  if (!e.deltaY) return;
  $("tabs").scrollLeft += e.deltaY;
  e.preventDefault();
}, { passive: false });

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
  for (const b of $("tabs").querySelectorAll<HTMLElement>("button")) list.push({ label: textOf(b), where: "Menu", run: () => open(b.dataset.tab!) });
  for (const section of menu.querySelectorAll<HTMLElement>("section[data-tab]")) {
    const tab = section.dataset.tab!;
    const title = textOf($("tabs").querySelector(`[data-tab="${CSS.escape(tab)}"]`));
    for (const el of section.querySelectorAll<HTMLElement>("button, input, select, textarea")) {
      const hiddenIn = el.parentElement?.closest("[hidden]");
      if ((el as HTMLButtonElement).disabled || el.hidden || (hiddenIn && hiddenIn !== section && section.contains(hiddenIn))) continue;
      const heading = [...section.querySelectorAll("h2, h3, b, label")].filter((h) => h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && !h.contains(el)).pop();
      const own = el.tagName === "BUTTON" ? textOf(el) : textOf(el.closest("label")) || el.getAttribute("aria-label") || (el as HTMLInputElement).placeholder || textOf(heading);
      if (!own) continue;
      const context = textOf(heading) && textOf(heading) !== own ? `${title} · ${textOf(heading)}` : title;
      list.push({ label: own, where: context, run: el.tagName === "BUTTON" ? () => el.click() : () => open(tab, el) });
    }
  }
  for (const b of menu.querySelectorAll<HTMLElement>(".actions button")) if (!b.hidden) list.push({ label: textOf(b), where: "Menu", run: () => b.click() });
  return list;
}
function openPalette() {
  commands = menuCommands();
  palette.hidden = false;
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
$("main-menu").hidden = !localStorage.getItem("sandbox-menu");
$("main-menu").onclick = () => location.assign("/menu");

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sandbox";

/** Single-quotes a shell argument, so prompts may contain apostrophes and world names anything. */
const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
let via = "cli";
try {
  via = localStorage.getItem("sandbox-via") ?? "cli";
} catch {}
/** Starts a Claude connected to this world, through a shell command it installs (fewer tokens than MCP tool schemas) or through MCP. */
const connectCommand = (prompt: (tools: string) => string, key: string | null, command: string) => {
  const base = publicUrl ?? origin;
  if (via === "mcp") {
    const name = slug(world);
    return `claude ${shellQuote(prompt(`the ${name} MCP tools`))} --mcp-config ${shellQuote(JSON.stringify({ mcpServers: { [name]: { type: "http", url: `${base}/mcp`, headers: { Authorization: `Bearer ${key}` } } } }))} --allowedTools mcp__${name} Agent WebSearch WebFetch`;
  }
  const bin = `~/.local/bin/${command}`;
  const tools = `the ${bin} command: run it alone to list its tools, call one as ${bin} <tool> name=value, and give wait_for_chat calls a Bash timeout of 300000`;
  return `mkdir -p ~/.local/bin && curl -fsS -H ${shellQuote(`Authorization: Bearer ${key}`)} ${shellQuote(`${base}/cli?name=${command}&url=${encodeURIComponent(base)}`)} -o ${bin} && chmod +x ${bin} && claude ${shellQuote(prompt(tools))} --allowedTools ${shellQuote(`Bash(${bin}:*)`)} Agent WebSearch WebFetch`;
};
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-via]")) {
  button.classList.toggle("active", button.dataset.via === via);
  button.onclick = () => {
    via = button.dataset.via!;
    try {
      localStorage.setItem("sandbox-via", via);
    } catch {}
    for (const b of document.querySelectorAll("[data-via]")) b.classList.toggle("active", b === button);
    openMenu();
  };
}

async function openMenu() {
  keys.clear();
  menu.hidden = false;
  replaying = false;
  if (document.pointerLockElement) document.exitPointerLock();
  $("menu-world").textContent = world;
  $("invite-link").textContent = `${publicUrl ?? origin}/#invite=${invite}`;
  $("claude-command").textContent = connectCommand(
    (tools) => `We are playing ${world} together right now: a live multiplayer 3D game that my friends and I build while we play it, each with our own Claude. I am ${me} in the game. You are connected to the game server through ${tools}, and anything you reload goes live for every player instantly, so build boldly but keep it fun for everyone. Start with the status tool and read GUIDE.md, then use say to tell me in-game in a line or two what the world has and one thing you could build. After that I stay in the game and talk to you through the in-game chat, and when I hold T or have the chat open my voice is transcribed into it too: read those spoken lines for what I want and how I feel, and act when I ask for something or clearly want a change, not on every word. call wait_for_chat with seconds 240, build what I (${me}) ask for there, say what you did, and wait again. Keep that loop going until I tell you to stop.`,
    key,
    slug(world),
  );
  showBuilders();
  await refreshMenu();
}

const myVotes = new Map<string, string>();
async function refreshMenu() {
  const status = await (await fetch("/api/status", { headers: { authorization: `Bearer ${key}` } })).json();
  $("gm-command").textContent = connectCommand(
    (tools) => `You are the game master of ${world}, a live multiplayer 3D game that my friends and I build with our own Claudes while we play it. You are connected to the game server through ${tools} as the game master, shared by every player. Start with the status tool, read GUIDE.md (especially its Game master section), then run the game master loop it describes until I tell you to stop.`,
    status.gameMaster.key,
    `${slug(world)}-gm`,
  );
  $("gm-state").textContent = { working: "Running", listening: "Running", offline: "" }[status.gameMaster.state as Builder["state"]];
  $("menu-players").replaceChildren(...status.online.map((p: string) => Object.assign(document.createElement("li"), { textContent: p === me ? `${p} (you)` : p })));
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
            b.classList.toggle("picked", myVotes.get(m.name) === `${m.version}:${b.dataset.kind}`);
            b.onclick = () => {
              myVotes.set(m.name, `${m.version}:${b.dataset.kind}`);
              send({ t: "react", mod: m.name, kind: b.dataset.kind });
            };
          }
          return li;
        })
      : [Object.assign(document.createElement("li"), { textContent: "No mods yet. The world is empty." })]),
  );
}

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy]"))
  button.onclick = async () => {
    await navigator.clipboard.writeText($(button.dataset.copy!).textContent!);
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1500);
  };

// ---------- loop ----------
const emptyHint = $("empty");
let welcomedAt = Infinity;
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  stats.frames.push(now - last);
  last = now;
  renderer.info.reset();
  const blend = 1 - Math.exp(-dt * 15);
  for (const [id, obj] of objects) {
    const e = entities.get(id);
    if (!e?.pos || obj.userData.manual) continue;
    obj.position.lerp(new THREE.Vector3().fromArray(e.pos), blend);
    if (e.rot) obj.rotation.set(e.rot[0] ?? 0, e.rot[1] ?? 0, e.rot[2] ?? 0);
  }
  for (const m of ordered) call(m, "frame", dt);
  showAction();
  if (replaying) {
    const a = now * 0.00015;
    camera.position.set(Math.cos(a) * orbit * 1.4, orbit * 0.8, Math.sin(a) * orbit * 1.4);
    camera.lookAt(0, 0, 0);
  }
  const drawStart = performance.now();
  draw(dt);
  stats.drawMs += performance.now() - drawStart;
  stats.loopMs += performance.now() - now;
  stats.calls += renderer.info.render.calls;
  stats.triangles += renderer.info.render.triangles;
  const hideHint = entities.size > 0 || mods.size > 0 || now - welcomedAt < 1000;
  if (emptyHint.hidden !== hideHint) emptyHint.hidden = hideHint;
});

function draw(dt: number) {
  let next = () => renderer.render(scene, camera);
  for (const m of ordered) {
    if (!m.mod.render) continue;
    const inner = next;
    next = () => call(m, "render", inner, dt);
  }
  next();
}

// ---------- debugging for the Claudes: the perf and logs tools ----------
const stats = { frames: [] as number[], loopMs: 0, drawMs: 0, calls: 0, triangles: 0, bytes: 0, ping: 0 };
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
    ...sceneCost(),
    entities: entities.size,
    pingMs: stats.ping,
    downloadKBps: r(stats.bytes / 1024 / ((now - reportedAt) / 1000)),
    heapMB: Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1048576) || undefined,
    screen: `${renderer.domElement.width}x${renderer.domElement.height} at pixel ratio ${renderer.getPixelRatio()}`,
    gpu: gpuName,
    hidden: document.hidden || undefined,
  });
  for (const m of ordered) m.ms = 0;
  Object.assign(stats, { frames: [], loopMs: 0, drawMs: 0, calls: 0, triangles: 0, bytes: 0 });
  reportedAt = now;
  forwarded = 0;
}, 2000);

// Tags every object with the mod whose code added it, so perf can name who owns the heavy ones.
const add = THREE.Object3D.prototype.add;
THREE.Object3D.prototype.add = function (...objects) {
  const mod = modOf(new Error().stack);
  if (mod) for (const o of objects) o.userData.mod ??= mod;
  return add.apply(this, objects);
};
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
    const mod = modOf(new Error().stack);
    if (!mod || ++forwarded > 30) return;
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

await start();
$("hud").hidden = false;
$("howto-world").textContent = info.name;
howto.hidden = false;
connect();
