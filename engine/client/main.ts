import * as THREE from "three";
import type { ClientCtx, ClientHooks, ClientMod, Entity } from "../api";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const hashParams = new URLSearchParams(location.hash.slice(1));

let key = localStorage.getItem("sandbox-key");
let me = "";
let world = "";
let invite = "";

async function join(body: object) {
  const res = await fetch("/api/join", { method: "POST", body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  localStorage.setItem("sandbox-key", data.key);
  key = data.key;
  me = data.name;
  history.replaceState(null, "", "/");
}

async function start() {
  if (key) {
    try {
      return await join({ key });
    } catch {
      localStorage.removeItem("sandbox-key");
    }
  }
  const info = await (await fetch("/api/info")).json();
  $("join-world").textContent = info.name;
  $("join-online").textContent = info.online ? `${info.online} playing now` : "Nobody is here yet";
  $("join").hidden = false;
  if (!hashParams.get("invite")) $("join-error").textContent = "Ask the host for an invite link to join.";
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
    let made: THREE.Object3D | null | undefined | void;
    guarded(m, "object", () => (made = m.mod.object!(m.ctx, id, e)));
    if (made) {
      custom.add(made);
      return made;
    }
  }
  return defaultObject(e);
}

function defaultObject(e: Entity) {
  const group = new THREE.Group();
  if (e.mesh) {
    const size = typeof e.mesh.size === "number" ? [e.mesh.size] : (e.mesh.size ?? [1]);
    const material = new THREE.MeshStandardMaterial({
      color: e.mesh.color ?? "#cccccc",
      emissive: e.mesh.emissive ?? "#000000",
      roughness: e.mesh.roughness ?? 0.8,
      metalness: e.mesh.metalness ?? 0,
      transparent: e.mesh.opacity !== undefined,
      opacity: e.mesh.opacity ?? 1,
    });
    const mesh = new THREE.Mesh(geometry(e.mesh.shape ?? "box", size), material);
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
    o.geometry?.dispose();
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

function applyEntities(set: Record<string, Entity>, removed: number[] = []) {
  for (const [id, e] of Object.entries(set)) {
    entities.set(Number(id), e);
    syncObject(Number(id), e, false);
  }
  for (const id of removed) {
    entities.delete(id);
    syncObject(id, undefined, false);
  }
}

// ---------- mods ----------
type Loaded = { name: string; url: string; mod: ClientMod; ctx: ClientCtx; errors: number };
const mods = new Map<string, Loaded>();
let ordered: Loaded[] = [];
const keys = new Set<string>();
let socket: WebSocket | null = null;
const send = (msg: object) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(msg));

function reorder() {
  ordered = [...mods.values()].sort((a, b) => (a.mod.order ?? 0) - (b.mod.order ?? 0) || a.name.localeCompare(b.name));
}

function guarded(m: Loaded, label: string, fn: () => void) {
  try {
    fn();
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

function call(m: Loaded, hook: keyof ClientHooks, ...args: any[]) {
  const base = m.mod[hook] as ((...a: any[]) => void) | undefined;
  let next = (...a: any[]) => guarded(m, hook, () => base?.call(m.mod, m.ctx, ...a));
  for (const w of ordered) {
    const fn = w !== m ? (w.mod.wrap?.[m.name]?.[hook] as ((...a: any[]) => void) | undefined) : undefined;
    if (!fn) continue;
    const inner = next;
    next = (...a: any[]) => guarded(w, `wrap ${m.name}.${hook}`, () => fn.call(w.mod, inner, w.ctx, ...a));
  }
  next(...args);
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
    mods.delete(name);
  }
  if (!mod || !url) {
    reorder();
    return rebuildAll();
  }
  const ctx: ClientCtx = { THREE, scene, camera, renderer, entities, objects, playerId: me, keys, send: (msg) => send({ t: "m", mod: name, msg }) };
  const loaded: Loaded = { name, url, mod, ctx, errors: 0 };
  mods.set(name, loaded);
  reorder();
  call(loaded, "init");
  if (mod.object || old?.mod.object) rebuildAll();
}

// ---------- network ----------
function connect() {
  const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/ws?key=${key}`);
  socket = ws;
  ws.onmessage = async ({ data }) => {
    const msg = JSON.parse(data);
    switch (msg.t) {
      case "welcome": {
        world = msg.world;
        invite = msg.invite;
        me = msg.playerId;
        $("world-name").textContent = world;
        $("rules").textContent = msg.rules === "additive" ? "additive" : "open";
        $("status").hidden = true;
        for (const id of [...entities.keys()]) if (!(id in msg.entities)) applyEntities({}, [id]);
        applyEntities(msg.entities);
        for (const [id, e] of entities) syncObject(id, e, true);
        const wanted = new Map<string, string>(msg.mods.map((m: any) => [m.name, m.url]));
        for (const name of mods.keys()) if (!wanted.has(name)) await loadMod(name, null);
        for (const [name, url] of wanted) await loadMod(name, url);
        for (const f of msg.feed) addLine(f.text, f.kind);
        return;
      }
      case "delta":
        return applyEntities(msg.set, msg.removed);
      case "mod":
        return loadMod(msg.name, msg.url);
      case "feed":
        addLine(msg.text, msg.kind);
        if (msg.kind !== "info") toast(msg.text, msg.kind);
        return;
      case "chat":
        return addLine(`${msg.from}: ${msg.text}`, msg.from.endsWith("'s Claude") ? "claude" : "chat");
    }
  };
  ws.onclose = (e) => {
    $("status").hidden = false;
    if (e.code === 4000) {
      $("status").textContent = "You opened the game in another tab.";
      return;
    }
    $("status").textContent = "Reconnecting…";
    setTimeout(connect, 1000);
  };
}

// ---------- HUD ----------
function addLine(text: string, kind = "info") {
  const line = document.createElement("div");
  line.className = `line ${kind}`;
  line.textContent = text;
  $("feed").append(line);
  while ($("feed").children.length > 40) $("feed").firstElementChild!.remove();
  $("feed").scrollTop = 1e9;
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
const typing = () => document.activeElement instanceof HTMLInputElement;

addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.code === "Enter" && !typing() && menu.hidden) {
    chat.hidden = false;
    chat.focus();
    e.preventDefault();
    return;
  }
  if ((e.code === "Escape" || e.code === "Tab") && !typing()) {
    e.preventDefault();
    return menu.hidden ? openMenu() : (menu.hidden = true);
  }
  if (!typing()) keys.add(e.code);
});
addEventListener("keyup", (e: KeyboardEvent) => keys.delete(e.code));
addEventListener("blur", () => keys.clear());
chat.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.code === "Enter") {
    if (chat.value.trim()) send({ t: "chat", text: chat.value.trim() });
    chat.value = "";
  }
  if (e.code === "Enter" || e.code === "Escape") {
    chat.blur();
    chat.hidden = true;
  }
  e.stopPropagation();
});
$("menu-button").onclick = () => openMenu();
$("menu-close").onclick = () => (menu.hidden = true);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sandbox";

async function openMenu() {
  keys.clear();
  menu.hidden = false;
  $("invite-link").textContent = `${location.origin}/#invite=${invite}`;
  const name = slug(world);
  const prompt = `We're playing ${world.replace(/['"`$\\]/g, "")} together right now: a live multiplayer 3D game that my friends and I build while we play it, each with our own Claude. I'm ${me} in the game. You're connected to the game server through the ${name} MCP tools, and anything you reload goes live for every player instantly, so build boldly but keep it fun for everyone. Start with the status tool and read GUIDE.md, then tell me in a few lines what the world has so far and suggest three things we could build next.`;
  $("claude-command").textContent = `claude mcp add -s user --transport http ${name} ${location.origin}/mcp --header "Authorization: Bearer ${key}"; claude '${prompt}'`;
  const status = await (await fetch("/api/status", { headers: { authorization: `Bearer ${key}` } })).json();
  $("menu-players").replaceChildren(...status.online.map((p: string) => Object.assign(document.createElement("li"), { textContent: p === me ? `${p} (you)` : p })));
  $("menu-mods").replaceChildren(
    ...(status.mods.length
      ? status.mods.map((m: any) => {
          const li = document.createElement("li");
          li.innerHTML = `<b></b><span></span>`;
          li.querySelector("b")!.textContent = m.name;
          li.querySelector("span")!.textContent = `by ${m.author} · v${m.version}`;
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
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  const blend = 1 - Math.exp(-dt * 15);
  for (const [id, obj] of objects) {
    const e = entities.get(id);
    if (!e?.pos) continue;
    obj.position.lerp(new THREE.Vector3().fromArray(e.pos), blend);
    if (e.rot) obj.rotation.set(e.rot[0] ?? 0, e.rot[1] ?? 0, e.rot[2] ?? 0);
  }
  for (const m of ordered) call(m, "frame", dt);
  let draw = () => renderer.render(scene, camera);
  for (const m of ordered) {
    if (!m.mod.render) continue;
    const inner = draw;
    draw = () => guarded(m, "render", () => m.mod.render!(m.ctx, inner, dt));
  }
  draw();
});

await start();
$("hud").hidden = false;
connect();
