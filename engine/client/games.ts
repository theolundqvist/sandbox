import type { Game } from "../api";

export type { Game };
/** Where a player is: in one of the world's games, or in the world itself (null). */
export type Seat = { player: string; name: string; game: string | null; online: boolean };
type Painter = (canvas: HTMLCanvasElement, t: number) => void;

/** The game picker: a full-screen console home screen with one animated card per game. Pure UI; main.ts feeds it games and seats and sends the switch. */
export function mountPicker(root: ShadowRoot | HTMLElement, opts: { me: string; onPlay(gameId: string | null): void; onClose?(): void; paintArt(gameId: string): Painter | null }) {
  const style = h("style");
  style.textContent = CSS;
  const el = h("div", "gp");
  el.tabIndex = -1;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Games");
  const [b1, b2] = [h("div", "gp-blob b1"), h("div", "gp-blob b2")];
  const head = h("div", "gp-head");
  const back = h("button", "gp-back");
  back.tabIndex = -1;
  back.onclick = () => leave();
  head.append(h("div", "gp-logo", "Games"), h("div", "gp-sub", "Choose your game"), back);
  const row = h("div", "gp-row");
  const foot = h("div", "gp-foot");
  el.append(b1, b2, h("div", "gp-grain"), head, row, foot);
  const cover = h("div", "gp-cover");
  const [coverTitle, coverSub, bar] = [h("div", "gp-cover-title"), h("div", "gp-cover-sub"), h("div", "gp-cover-bar")];
  bar.append(h("i"));
  cover.append(coverTitle, coverSub, bar);
  // First in the root, so the Tab menu and anything else the engine adds later stays on top.
  root.prepend(style, el, cover);

  type Card = { game: Game; el: HTMLDivElement; tilt: HTMLDivElement; canvas: HTMLCanvasElement; painter: Painter | null; t: number; tx: number; ty: number; px: number; py: number; who: string };
  let games: Game[] = [];
  let seats: Seat[] = [];
  let mods: Record<string, number> = {};
  let cards: Card[] = [];
  let focus = 0;
  let shape = "";
  let opened = false;
  let frame = 0;
  let last = 0;
  let pad: "keys" | "pad" = "keys";
  let held = new Set<string>();
  let repeatAt = 0;
  let switchingTo: string | null = null;
  let coverAt = 0;
  const timers = { close: 0, hide: 0, stuck: 0 };
  const resize = new ResizeObserver((entries) => {
    for (const e of entries) {
      const canvas = e.target as HTMLCanvasElement;
      const dpr = Math.min(1.5, devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    }
    edges();
  });

  const current = () => seats.find((s) => s.player === opts.me)?.game ?? null;
  /** Being built and no mod in it yet: nothing to play. */
  const soon = (g: Game) => g.status === "building" && !(mods[g.id]! > 0);

  function build() {
    const cur = current();
    const next = cur + "|" + games.map((g) => [g.id, g.title, g.tagline, g.color, g.accent, g.status, soon(g)].join("~")).join("|");
    if (next === shape) return;
    shape = next;
    const keep = cards[focus]?.game.id;
    for (const c of cards) resize.unobserve(c.canvas);
    row.textContent = "";
    cards = games.map((g, i) => card(g, i, g.id === cur));
    if (!cards.length) row.append(h("div", "gp-empty", "No games in this world yet. Ask your Claude to make one."));
    const at = cards.findIndex((c) => c.game.id === keep);
    setFocus(at >= 0 ? at : Math.max(0, cards.findIndex((c) => c.game.id === cur)), false);
    back.textContent = "Back to the world";
    back.title = cur ? "Leave this game for the world" : "Close";
  }

  function card(g: Game, i: number, playing: boolean): Card {
    const el = h("div", `gp-card ${g.status}` + (soon(g) ? " soon" : ""));
    el.style.setProperty("--i", String(i));
    colors(el, g);
    const tilt = h("div", "gp-tilt");
    const art = h("div", "gp-art");
    const canvas = h("canvas");
    art.append(canvas, h("div", "gp-shine"));
    const badges = h("div", "gp-badges");
    badges.append(h("span", `gp-status ${g.status}`, STATUS[g.status] ?? g.status));
    if (playing) badges.append(h("span", "gp-playing", "Playing"));
    const body = h("div", "gp-body");
    body.append(h("div", "gp-title" + (g.title.length > 11 ? " long" : ""), g.title), h("div", "gp-tag", g.tagline));
    if (g.status !== "live") body.append(h("div", `gp-note ${g.status}`, soon(g) ? "Check back soon" : "Being built right now"));
    const btn = h("button", "gp-play" + (playing ? " resume" : ""), soon(g) ? "Coming soon" : playing ? "Resume" : "Play");
    btn.tabIndex = -1;
    btn.disabled = soon(g);
    body.append(h("div", "gp-who"), btn);
    tilt.append(art, badges, body);
    el.append(tilt);
    const c: Card = { game: g, el, tilt, canvas, painter: painterOf(g.id), t: i * 7.3, tx: 0, ty: 0, px: 0, py: 0, who: "\0" };
    el.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && setFocus(cards.indexOf(c)));
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      c.tx = x * 2 - 1;
      c.ty = y * 2 - 1;
      tilt.style.setProperty("--mx", `${Math.round(x * 100)}%`);
      tilt.style.setProperty("--my", `${Math.round(y * 100)}%`);
    });
    el.addEventListener("pointerleave", () => (c.tx = c.ty = 0));
    el.addEventListener("click", () => {
      setFocus(cards.indexOf(c));
      play(g.id);
    });
    row.append(el);
    resize.observe(canvas);
    return c;
  }

  /** The game's own art mod if it is loaded, else null for the default painting. */
  function painterOf(id: string): Painter | null {
    try {
      return opts.paintArt(id);
    } catch {
      return null;
    }
  }

  function who() {
    const me = opts.me;
    for (const c of cards) {
      const here = seats.filter((s) => s.online && s.game === c.game.id).sort((a, b) => +(b.player === me) - +(a.player === me) || a.name.localeCompare(b.name));
      const sig = here.map((s) => s.player + ":" + s.name).join(",");
      if (sig === c.who) continue;
      c.who = sig;
      const box = c.el.querySelector(".gp-who")!;
      box.textContent = "";
      box.append(h("span", "gp-count" + (here.length ? "" : " none"), here.length ? `${here.length} playing` : "No one here yet"));
      for (const s of here.slice(0, 5)) box.append(h("span", "gp-name" + (s.player === me ? " me" : ""), s.player === me ? `${s.name} (you)` : s.name));
      if (here.length > 5) box.append(h("span", "gp-name", `+${here.length - 5}`));
    }
  }

  function setFocus(i: number, scroll = true) {
    if (!cards.length) return;
    focus = Math.max(0, Math.min(cards.length - 1, i));
    cards.forEach((c, k) => c.el.classList.toggle("focus", k === focus));
    const g = cards[focus]!.game;
    el.style.setProperty("--fc", g.color);
    b1.style.background = g.color;
    b2.style.background = g.accent ?? g.color;
    if (scroll) cards[focus]!.el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }

  function move(dx: number, dy: number) {
    const n = cards.length;
    if (!n) return;
    let next = focus;
    if (dx) next = (focus + dx + n) % n;
    else {
      const top = (k: number) => cards[k]!.el.offsetTop;
      const perRow = cards.filter((_, k) => top(k) === top(0)).length || 1;
      next = Math.max(0, Math.min(n - 1, focus + dy * perRow));
    }
    if (next !== focus) setFocus(next);
  }

  function play(id: string) {
    const g = games.find((x) => x.id === id);
    const c = cards.find((x) => x.game.id === id);
    if (!g || switchingTo) return;
    if (id === current()) return close();
    if (soon(g)) {
      c?.el.classList.remove("nope");
      void c?.el.offsetWidth;
      c?.el.classList.add("nope");
      return;
    }
    c?.el.classList.add("launch");
    switching(id);
    opts.onPlay(id);
  }

  /** In a game, Back leaves it for the world's hub; in the hub it only closes. */
  function leave() {
    if (switchingTo) return;
    if (!current()) return close();
    raise(HUB, "The world", undefined, "Back to the world");
    opts.onPlay(null);
  }

  function raise(key: string, title: string, g: Game | undefined, sub: string) {
    clearTimeout(timers.hide);
    colors(cover, g);
    coverTitle.textContent = title;
    coverSub.textContent = sub;
    if (switchingTo !== key) coverAt = performance.now();
    switchingTo = key;
    cover.classList.remove("slow");
    cover.classList.add("on");
    // The picker goes once the cover is opaque, so the world never shows between them.
    clearTimeout(timers.close);
    timers.close = window.setTimeout(close, FADE_MS);
    clearTimeout(timers.stuck);
    timers.stuck = window.setTimeout(() => switching(null), 20000);
  }

  function switching(id: string | null) {
    if (id) {
      const g = games.find((x) => x.id === id);
      return raise(id, g?.title ?? id, g, g?.status === "live" ? "Loading" : g?.status === "early" ? "Early access" : "Being built");
    }
    clearTimeout(timers.hide);
    clearTimeout(timers.stuck);
    // Held a moment, so a quick switch still reads as one.
    timers.hide = window.setTimeout(() => {
      switchingTo = null;
      cover.classList.add("slow");
      cover.classList.remove("on");
      for (const c of cards) c.el.classList.remove("launch");
    }, Math.max(0, MIN_COVER_MS - (performance.now() - coverAt)));
  }

  /** Keys only while the picker has the focus, so the Tab menu or chat opened over it keeps theirs. */
  function ours() {
    const inner = root instanceof ShadowRoot ? root.activeElement : null;
    const active = inner ?? document.activeElement;
    return !active || active === document.body || el.contains(active);
  }

  function onKey(e: KeyboardEvent) {
    if (!opened || e.metaKey || e.ctrlKey || e.altKey || !ours()) return;
    const step = KEYS[e.code];
    if (!step) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (switchingTo) return;
    if (pad !== "keys") hints((pad = "keys"));
    if (step === "play") cards[focus] && play(cards[focus]!.game.id);
    else if (step === "close") close();
    else move(step[0], step[1]);
  }

  /** Buttons that went down this frame, and the stick as a direction that repeats while held. */
  function gamepad(now: number) {
    const gp = [...(navigator.getGamepads?.() ?? [])].find((p) => p?.connected);
    if (!gp) return;
    const down = new Set<string>();
    const b = (i: number) => !!gp.buttons[i]?.pressed;
    const [ax = 0, ay = 0] = gp.axes;
    if (b(0)) down.add("a");
    if (b(1)) down.add("b");
    if (b(14) || ax < -0.5) down.add("l");
    if (b(15) || ax > 0.5) down.add("r");
    if (b(12) || ay < -0.5) down.add("u");
    if (b(13) || ay > 0.5) down.add("d");
    const fresh = [...down].filter((k) => !held.has(k));
    const dir = ["l", "r", "u", "d"].find((k) => down.has(k));
    held = down;
    if (!ours() || switchingTo) return;
    if (fresh.length && pad !== "pad") hints((pad = "pad"));
    if (fresh.includes("a")) return cards[focus] && play(cards[focus]!.game.id);
    if (fresh.includes("b")) return close();
    if (!dir) return;
    if (fresh.includes(dir)) repeatAt = now + 380;
    else if (now >= repeatAt) repeatAt = now + 130;
    else return;
    move(dir === "l" ? -1 : dir === "r" ? 1 : 0, dir === "u" ? -1 : dir === "d" ? 1 : 0);
  }

  function tick(now: number) {
    frame = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    gamepad(now);
    const k = 1 - Math.exp(-dt * 8);
    cards.forEach((c, i) => {
      const focused = i === focus;
      c.px += (c.tx - c.px) * k;
      c.py += (c.ty - c.py) * k;
      c.t += dt * (focused ? 1 : 0.55);
      const tilt = `rotateX(${(-c.py * 7).toFixed(2)}deg) rotateY(${(c.px * 9).toFixed(2)}deg)`;
      c.tilt.style.transform = focused ? `translateY(-10px) scale(1.035) ${tilt}` : tilt;
      if (c.painter) {
        try {
          return c.painter(c.canvas, c.t);
        } catch (e) {
          console.warn(`games: ${c.game.id}'s card art failed`, e);
          c.painter = null;
        }
      }
      paint(c.canvas, c.t, c.game, c.px, c.py);
    });
  }

  /** Fades the row's edges only on the sides that have more cards off screen. */
  function edges() {
    const more = row.scrollWidth - row.clientWidth > 2;
    row.classList.toggle("more-l", more && row.scrollLeft > 2);
    row.classList.toggle("more-r", more && row.scrollLeft + row.clientWidth < row.scrollWidth - 2);
  }
  row.addEventListener("scroll", edges, { passive: true });
  row.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || row.scrollWidth <= row.clientWidth) return;
    e.preventDefault();
    row.scrollLeft += e.deltaY;
  }, { passive: false });

  function hints(kind: "keys" | "pad") {
    foot.innerHTML = kind === "pad"
      ? `<span><kbd>✛</kbd>Choose</span><span><kbd>A</kbd>Play</span><span><kbd>B</kbd>Close</span>`
      : `<span><kbd>←</kbd><kbd>→</kbd>Choose</span><span><kbd>Enter</kbd>Play</span><span><kbd>Esc</kbd>Close</span><span><kbd>G</kbd>Games anytime</span>`;
  }
  hints("keys");

  function open() {
    if (opened) return;
    opened = true;
    shape = "";
    build();
    for (const c of cards) c.painter = painterOf(c.game.id);
    who();
    setFocus(Math.max(0, cards.findIndex((c) => c.game.id === current())), false);
    document.exitPointerLock?.();
    el.classList.add("open");
    el.focus({ preventScroll: true });
    cards[focus]?.el.scrollIntoView({ block: "nearest", inline: "center" });
    requestAnimationFrame(() => requestAnimationFrame(() => opened && el.classList.add("in")));
    held = new Set(["a", "b", "l", "r", "u", "d"]);
    addEventListener("keydown", onKey, true);
    last = 0;
    frame = requestAnimationFrame(tick);
    edges();
  }

  function close() {
    if (!opened) return;
    opened = false;
    clearTimeout(timers.close);
    cancelAnimationFrame(frame);
    removeEventListener("keydown", onKey, true);
    el.classList.remove("open", "in");
    opts.onClose?.();
    const active = (root instanceof ShadowRoot ? root.activeElement : null) ?? document.activeElement;
    if (active instanceof HTMLElement && el.contains(active)) active.blur();
  }

  return {
    update(nextGames: Game[], nextSeats: Seat[], nextMods: Record<string, number>) {
      games = [...nextGames].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title));
      seats = nextSeats;
      mods = nextMods ?? {};
      if (!opened) return;
      build();
      who();
      edges();
    },
    open,
    close,
    isOpen: () => opened,
    switching,
  };
}

const FADE_MS = 480;
const MIN_COVER_MS = 900;
/** The cover's key while going back to the hub, which no game id can be. */
const HUB = "~hub";
const STATUS: Record<string, string> = { live: "Live", early: "Early access", building: "Being built" };
const KEYS: Record<string, "play" | "close" | [number, number]> = {
  ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0], ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
  Enter: "play", Space: "play", NumpadEnter: "play", Escape: "close",
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function colors(el: HTMLElement, g: Game | undefined) {
  el.style.setProperty("--c", g?.color || "#ffb547");
  el.style.setProperty("--a", g?.accent || g?.color || "#ffffff");
}


// ---------------------------------------------------------------- the default card art: a painted landscape from the card's colours, shaped by its id

type RGB = [number, number, number];
type Scene = {
  key: string; night: boolean; sky: [RGB, RGB, RGB]; body: 0 | 1 | 2; bx: number; by: number; bodyC: RGB; acc: RGB; haze: RGB; water: boolean;
  stars: number[][]; clouds: number[][]; layers: { ys: Float32Array; fill: RGB; y: number }[]; motes: number[][]; moteKind: 0 | 1 | 2;
};
const TAU = Math.PI * 2;
const scenes = new Map<string, Scene>();
let probe: CanvasRenderingContext2D | null = null;

/** Any CSS colour as RGB, through a canvas so names, hsl() and the rest all work. */
function rgb(css: string | undefined, fallback: string): RGB {
  probe ??= document.createElement("canvas").getContext("2d")!;
  probe.fillStyle = fallback;
  if (css) probe.fillStyle = css;
  const v = String(probe.fillStyle);
  if (v.startsWith("#")) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as RGB;
  const m = v.match(/[\d.]+/g) ?? ["0", "0", "0"];
  return [+m[0]!, +m[1]!, +m[2]!];
}
const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const rgba = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const wrap = (v: number, m: number) => ((v % m) + m) % m;
const smooth = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v));

function seeded(id: string) {
  let s = 2166136261;
  for (const ch of id) s = Math.imul(s ^ ch.charCodeAt(0), 16777619);
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BLACK: RGB = [5, 6, 13], WHITE: RGB = [255, 250, 240];
const SAMPLES = 160;
const SPAN = 1.3;

/** The scene is fixed by the card: the id seeds its shapes, the colours tint it. */
function scene(g: Game): Scene {
  const key = `${g.id}|${g.color}|${g.accent}`;
  const had = scenes.get(g.id);
  if (had?.key === key) return had;
  const r = seeded(g.id);
  const base = rgb(g.color, "#ffb547"), acc = rgb(g.accent ?? g.color, "#ffffff");
  const night = r() < 0.45;
  const sky: [RGB, RGB, RGB] = night
    ? [mix(base, BLACK, 0.9), mix(base, BLACK, 0.62), mix(mix(acc, base, 0.4), BLACK, 0.3)]
    : [mix(base, BLACK, 0.5), mix(base, WHITE, 0.1), mix(acc, WHITE, 0.35)];
  const haze = mix(sky[2], sky[1], 0.45);
  const deep = mix(base, BLACK, night ? 0.84 : 0.72);
  const terrain = Math.floor(r() * 4);
  const water = r() < 0.4;
  const layers = [0, 1, 2, 3].slice(0, water ? 3 : 4).map((i) => {
    const ys = new Float32Array(SAMPLES + 1);
    const f1 = 3 + r() * 4 + i * 1.5, f2 = f1 * (2.1 + r()), p1 = r() * TAU, p2 = r() * TAU;
    const amp = [0.26, 0.18, 0.13, 0.09][i]! * (terrain === 1 ? 0.7 : 1) * (water ? 0.85 : 1);
    const y = water ? [0.4, 0.48, 0.56][i]! : [0.44, 0.53, 0.63, 0.75][i]!;
    // spires: shards standing out of the ridge, fewer and broader up close
    const spires = terrain === 3 ? [...Array(6 - i)].map(() => [r() * SPAN, 0.025 + r() * 0.035, (0.4 + r() * 0.7) * amp]) : [];
    for (let j = 0; j <= SAMPLES; j++) {
      const x = (j / SAMPLES) * SPAN;
      let v = terrain === 0
        ? (1 - Math.abs(Math.sin(x * f1 + p1))) ** 1.6 * 0.75 + (1 - Math.abs(Math.sin(x * f2 + p2))) * 0.25
        : 0.5 + Math.sin(x * f1 + p1) * 0.32 + Math.sin(x * f2 + p2) * 0.18;
      if (terrain === 2) v = 0.2 + smooth((v - 0.55) * 5) * 0.7 + Math.sin(x * f2 * 2.3 + p1) * 0.06;
      let top = y - v * amp;
      for (const [sx, sw, sh] of spires) top -= Math.max(0, 1 - Math.abs(x - sx!) / sw!) ** 1.3 * sh!;
      ys[j] = top;
    }
    return { ys, y, fill: mix(mix(haze, base, 0.3), deep, 0.18 + i * 0.26) };
  });
  const s: Scene = {
    key, night, sky, haze, acc, layers, water,
    body: Math.floor(r() * 3) as 0 | 1 | 2,
    bx: 0.22 + r() * 0.56, by: 0.2 + r() * 0.1,
    bodyC: mix(acc, WHITE, night ? 0.72 : 0.55),
    stars: [...Array(night ? 70 : 16)].map(() => [r(), r() * 0.5, 0.5 + r() * 1.2, r() * TAU, 1 + r() * 2]),
    clouds: [...Array(5)].map(() => [r() * 1.4, 0.12 + r() * 0.26, 0.12 + r() * 0.16, 0.004 + r() * 0.01]),
    motes: [...Array(24)].map(() => [r(), r(), 0.5 + r(), r() * TAU]),
    moteKind: Math.floor(r() * 3) as 0 | 1 | 2,
  };
  scenes.set(g.id, s);
  return s;
}

function glow(c: CanvasRenderingContext2D, x: number, y: number, r: number, inner: string) {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, inner);
  g.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = g;
  c.fillRect(x - r, y - r, r * 2, r * 2);
}

/** Sky, a sun, moon or ringed planet, drifting clouds, ridges fading into haze, maybe a lake, and motes in the accent colour; the pointer and time pan the layers apart. */
function paint(canvas: HTMLCanvasElement, t: number, g: Game, px: number, py: number) {
  const c = canvas.getContext("2d");
  if (!c) return;
  const w = canvas.width, hh = canvas.height, s = scene(g);
  const sky = c.createLinearGradient(0, 0, 0, hh * 0.72);
  sky.addColorStop(0, rgba(s.sky[0]));
  sky.addColorStop(0.55, rgba(s.sky[1]));
  sky.addColorStop(1, rgba(s.sky[2]));
  c.fillStyle = sky;
  c.fillRect(0, 0, w, hh);
  for (const [x, y, size, phase, speed] of s.stars) {
    c.fillStyle = `rgba(255,255,255,${(0.25 + 0.75 * Math.sin(t * speed! + phase!) ** 2) * (s.night ? 0.9 : 0.3)})`;
    const d = size! * hh * 0.004;
    c.fillRect(x! * w - px * 2, y! * hh - py * 2, d, d);
  }
  const bx = s.bx * w - px * w * 0.015, by = s.by * hh - py * hh * 0.01, br = hh * 0.075;
  // the horizon glows under the light
  c.save();
  c.translate(bx, hh * 0.46);
  c.scale(2.4, 1);
  glow(c, 0, 0, hh * 0.32, rgba(mix(s.sky[2], WHITE, 0.25), s.night ? 0.3 : 0.5));
  c.restore();
  glow(c, bx, by, hh * 0.42, rgba(mix(s.sky[2], WHITE, 0.3), s.night ? 0.2 : 0.4));
  if (s.body === 0) {
    c.save();
    c.translate(bx, by);
    c.rotate(t * 0.05);
    c.fillStyle = rgba(s.bodyC, 0.06);
    for (let i = 0; i < 10; i++) {
      c.rotate(TAU / 10);
      c.beginPath();
      c.moveTo(0, 0);
      c.lineTo(w * 1.2, -w * 0.06);
      c.lineTo(w * 1.2, w * 0.06);
      c.fill();
    }
    c.restore();
    glow(c, bx, by, br * 2.4, rgba(s.bodyC, 0.75));
    c.fillStyle = rgba(mix(s.bodyC, WHITE, 0.65));
    c.beginPath();
    c.arc(bx, by, br, 0, TAU);
    c.fill();
  } else if (s.body === 1) {
    glow(c, bx, by, br * 2.8, rgba(s.bodyC, 0.3));
    c.fillStyle = rgba(s.bodyC);
    c.beginPath();
    c.arc(bx, by, br, 0, TAU);
    c.fill();
    // the dark side is the sky itself, so the crescent sits in it seamlessly
    c.fillStyle = sky;
    c.beginPath();
    c.arc(bx + br * 0.42, by - br * 0.22, br * 0.9, 0, TAU);
    c.fill();
  } else {
    const tilt = -0.32, rx = br * 2.1, ry = br * 0.5;
    const ring = (from: number, to: number) => {
      c.strokeStyle = rgba(mix(s.acc, WHITE, 0.45), 0.75);
      c.lineWidth = br * 0.14;
      c.beginPath();
      c.ellipse(bx, by, rx, ry, tilt, from, to);
      c.stroke();
    };
    glow(c, bx, by, br * 2.6, rgba(s.bodyC, 0.25));
    ring(Math.PI, TAU);
    const shade = c.createLinearGradient(bx - br, by - br, bx + br, by + br);
    shade.addColorStop(0, rgba(mix(s.bodyC, WHITE, 0.4)));
    shade.addColorStop(1, rgba(mix(s.bodyC, BLACK, 0.55)));
    c.fillStyle = shade;
    c.beginPath();
    c.arc(bx, by, br, 0, TAU);
    c.fill();
    ring(0, Math.PI);
  }
  for (const [x, y, size, speed] of s.clouds) {
    const cx = wrap(x! * w + t * speed! * w - px * w * 0.02, w * 1.4) - w * 0.2, cy = y! * hh;
    c.save();
    c.translate(cx, cy);
    c.scale(3.2, 1);
    glow(c, 0, 0, size! * hh * 0.6, rgba(mix(s.haze, WHITE, s.night ? 0.1 : 0.5), s.night ? 0.12 : 0.26));
    c.restore();
  }
  // rim light: brightest along the ridges nearest the light
  const rim = c.createLinearGradient(0, 0, w, 0);
  const lit = Math.max(0.05, Math.min(0.95, bx / w));
  rim.addColorStop(0, rgba(mix(s.acc, WHITE, 0.4), 0.05));
  rim.addColorStop(lit, rgba(mix(s.acc, WHITE, 0.4), 0.55));
  rim.addColorStop(1, rgba(mix(s.acc, WHITE, 0.4), 0.05));
  s.layers.forEach((layer, i) => {
    const pan = (-px * 0.025 + Math.sin(t * 0.06 + i) * 0.012) * (i + 1) * w - w * 0.15;
    const lift = py * (i + 1) * hh * 0.006;
    let top = 1;
    for (const y of layer.ys) top = Math.min(top, y);
    c.beginPath();
    c.moveTo(pan, hh);
    for (let j = 0; j <= SAMPLES; j++) c.lineTo(pan + (j / SAMPLES) * SPAN * w, layer.ys[j]! * hh - lift);
    c.lineTo(pan + SPAN * w, hh);
    c.closePath();
    const fill = c.createLinearGradient(0, top * hh, 0, hh);
    fill.addColorStop(0, rgba(mix(layer.fill, s.acc, 0.14)));
    fill.addColorStop(0.45, rgba(layer.fill));
    fill.addColorStop(1, rgba(mix(layer.fill, BLACK, 0.45)));
    c.fillStyle = fill;
    c.fill();
    if (i < 3) {
      c.save();
      c.clip();
      c.globalAlpha = 0.85 - i * 0.25;
      c.strokeStyle = rim;
      c.lineWidth = hh * 0.012;
      c.stroke();
      c.restore();
    }
    // haze pooled in the valley in front of each ridge
    const fog = c.createLinearGradient(0, layer.y * hh - hh * 0.07, 0, layer.y * hh + hh * 0.05);
    fog.addColorStop(0, rgba(s.haze, 0));
    fog.addColorStop(0.65, rgba(s.haze, 0.26 - i * 0.05));
    fog.addColorStop(1, rgba(s.haze, 0));
    c.fillStyle = fog;
    c.fillRect(0, layer.y * hh - hh * 0.07, w, hh * 0.12);
  });
  if (s.water) {
    // a still lake: the sky mirrored, darker, with the light's path glittering on it
    const wy = 0.58 * hh;
    const lake = c.createLinearGradient(0, wy, 0, hh);
    lake.addColorStop(0, rgba(mix(mix(s.sky[2], s.sky[1], 0.5), BLACK, 0.55)));
    lake.addColorStop(1, rgba(mix(s.sky[0], BLACK, 0.6)));
    c.fillStyle = lake;
    c.fillRect(0, wy, w, hh - wy);
    c.fillStyle = rgba(mix(s.acc, WHITE, 0.5), 0.3);
    c.fillRect(0, wy, w, Math.max(1, hh * 0.004));
    for (let k = 0; k < 14; k++) {
      const ly = wy + (k + 1) * (hh - wy) * 0.07;
      const width = w * (0.05 + 0.03 * k) * (0.6 + 0.4 * Math.sin(t * 1.3 + k * 1.7));
      c.fillStyle = rgba(mix(s.bodyC, WHITE, 0.4), 0.45 - k * 0.03);
      c.fillRect(bx - width / 2 + Math.sin(t * 0.9 + k) * w * 0.01, ly, width, Math.max(1, hh * 0.004));
    }
  }
  const moteC = mix(s.acc, WHITE, s.moteKind === 1 ? 0.7 : 0.2);
  for (const [x, y, speed, phase] of s.motes) {
    let mx: number, my: number, a: number;
    if (s.moteKind === 0) { // embers rising
      my = wrap(y! - t * 0.05 * speed!, 1);
      mx = x! + Math.sin(t * 0.8 + phase!) * 0.03;
      a = 0.9 * Math.sin(my * Math.PI);
    } else if (s.moteKind === 1) { // dust drifting down
      my = wrap(y! + t * 0.03 * speed!, 1);
      mx = x! + Math.sin(t * 0.5 + phase!) * 0.04;
      a = 0.7 * Math.sin(my * Math.PI);
    } else { // fireflies wandering low
      mx = x! + Math.sin(t * 0.3 * speed! + phase!) * 0.05;
      my = 0.5 + y! * 0.45 + Math.cos(t * 0.4 * speed! + phase!) * 0.03;
      a = Math.max(0, Math.sin(t * 1.6 * speed! + phase! * 3));
    }
    const X = wrap(mx, 1) * w - px * w * 0.04, Y = my * hh, r = hh * 0.005 * speed!;
    glow(c, X, Y, r * 5, rgba(moteC, a * 0.35));
    c.fillStyle = rgba(mix(moteC, WHITE, 0.5), a);
    c.beginPath();
    c.arc(X, Y, r, 0, TAU);
    c.fill();
  }
  // darker at the top, so the badges read on any sky
  const shade = c.createLinearGradient(0, 0, 0, hh * 0.22);
  shade.addColorStop(0, "rgba(0,0,0,.28)");
  shade.addColorStop(1, "rgba(0,0,0,0)");
  c.fillStyle = shade;
  c.fillRect(0, 0, w, hh * 0.22);
}

// ---------------------------------------------------------------- styles (the arcade's look; rules beat the menu's own `button` rules they share the shadow root with)

const CSS = `
.gp { position: fixed; inset: 0; z-index: 1001; display: flex; flex-direction: column; overflow: hidden auto; outline: none; color: #fff;
  background: radial-gradient(ellipse at 50% 115%, rgba(40,50,90,.9), transparent 60%), #06070c;
  font: 14px/1.4 "SF Pro Text", "Segoe UI", Inter, system-ui, sans-serif; letter-spacing: normal; text-transform: none;
  opacity: 0; visibility: hidden; transition: opacity .25s ease, visibility 0s linear .25s; }
.gp.open { opacity: 1; visibility: visible; transition: opacity .25s ease; }
.gp *, .gp *::before, .gp *::after { box-sizing: border-box; }
.gp:not(.in) .gp-card { opacity: 0; transform: translateY(40px) scale(.96); }
.gp:not(.in) .gp-head { opacity: 0; transform: translateY(-16px); }
.gp-blob { position: fixed; width: 60vmax; height: 60vmax; border-radius: 50%; filter: blur(90px); opacity: .3; pointer-events: none; transition: background 1s ease; }
.gp-blob.b1 { left: -15vmax; top: -20vmax; animation: gp-drift1 18s ease-in-out infinite alternate; }
.gp-blob.b2 { right: -18vmax; bottom: -25vmax; animation: gp-drift2 22s ease-in-out infinite alternate; }
.gp:not(.open) .gp-blob, .gp:not(.open) .gp-logo, .gp:not(.open) .gp-status.live::before { animation-play-state: paused; }
@keyframes gp-drift1 { to { transform: translate(18vmax, 10vmax) scale(1.2); } }
@keyframes gp-drift2 { to { transform: translate(-14vmax, -12vmax) scale(1.1); } }
.gp-grain { position: fixed; inset: 0; pointer-events: none; opacity: .5; background-image: radial-gradient(rgba(255,255,255,.07) 1px, transparent 1px); background-size: 3px 3px; }
.gp-head { position: relative; display: flex; align-items: flex-end; gap: 24px; padding: 44px 56px 0; transition: all .5s cubic-bezier(.2,.8,.2,1); }
.gp-logo { font: 900 44px/1 var(--display, "Archivo Expanded", system-ui, sans-serif); letter-spacing: .08em; text-transform: uppercase;
  background: linear-gradient(100deg, #fff 0%, #fff 38%, var(--fc, #ffb547) 50%, #fff 62%, #fff 100%); background-size: 250% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent; animation: gp-shimmer 5s linear infinite; }
@keyframes gp-shimmer { from { background-position: 120% 0; } to { background-position: -120% 0; } }
.gp-sub { font-weight: 700; font-size: 12px; letter-spacing: .28em; text-transform: uppercase; color: rgba(255,255,255,.55); padding-bottom: 6px; }
.gp button.gp-back { margin-left: auto; display: flex; align-items: center; gap: 10px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.18); color: #fff; border-radius: 999px; padding: 12px 18px;
  font: 700 12px/1 var(--display, system-ui); letter-spacing: .14em; text-transform: uppercase; }
.gp button.gp-back:hover { background: #fff; color: #0b0b0c; }
.gp kbd { font: 700 10px/1 system-ui, sans-serif; letter-spacing: .04em; border: 1px solid currentColor; border-radius: 4px; padding: 3px 5px; margin: 0; opacity: .6; }
.gp-row { position: relative; flex: 1; display: flex; align-items: center; gap: 26px; padding: 40px 56px; overflow: auto hidden; scroll-snap-type: x proximity; scroll-padding: 0 56px; scrollbar-width: none; perspective: 1400px;
  --ml: #000; --mr: #000; -webkit-mask-image: linear-gradient(90deg, var(--ml), #000 120px, #000 calc(100% - 120px), var(--mr)); mask-image: linear-gradient(90deg, var(--ml), #000 120px, #000 calc(100% - 120px), var(--mr)); }
.gp-row::-webkit-scrollbar { display: none; }
.gp-row.more-l { --ml: transparent; } .gp-row.more-r { --mr: transparent; }
.gp-row > :first-child { margin-left: auto; } .gp-row > :last-child { margin-right: auto; }
.gp-card { position: relative; flex: none; width: clamp(200px, 16.5vw, 290px); height: clamp(380px, 60vh, 470px); cursor: pointer; scroll-snap-align: center;
  transition: opacity .6s cubic-bezier(.2,.8,.2,1), transform .6s cubic-bezier(.2,.8,.2,1); transition-delay: calc(var(--i) * 70ms); }
.gp-tilt { position: absolute; inset: 0; border-radius: 22px; overflow: hidden; background: #0d0f16; transform-style: preserve-3d;
  box-shadow: 0 18px 40px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.08); transition: transform .25s cubic-bezier(.2,.8,.2,1), box-shadow .25s ease; }
.gp-card.focus .gp-tilt { box-shadow: 0 26px 60px rgba(0,0,0,.6), 0 0 0 2px var(--c), 0 0 46px color-mix(in srgb, var(--c) 55%, transparent); }
.gp-card.launch .gp-tilt { transform: scale(1.12) !important; transition: transform .5s cubic-bezier(.5,0,.2,1); }
.gp-card.nope .gp-tilt { animation: gp-nope .36s ease; }
@keyframes gp-nope { 20%, 60% { translate: -7px 0; } 40%, 80% { translate: 7px 0; } }
.gp-art { position: absolute; left: 0; right: 0; top: 0; height: 60%; overflow: hidden; }
.gp-art canvas { width: 100%; height: 100%; display: block; }
.gp-art::after { content: ""; position: absolute; inset: auto 0 0 0; height: 32%; background: linear-gradient(transparent, #0d0f16); }
.gp-shine { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .25s; mix-blend-mode: overlay;
  background: radial-gradient(circle at var(--mx, 50%) var(--my, 30%), rgba(255,255,255,.28), transparent 45%); }
.gp-card.focus .gp-shine { opacity: 1; }
.gp-card.soon .gp-art { filter: saturate(.75) brightness(.85); }
.gp-badges { position: absolute; top: 14px; left: 14px; right: 14px; display: flex; gap: 6px; align-items: center; }
.gp-status, .gp-playing { font-weight: 800; font-size: 10px; line-height: 1; letter-spacing: .16em; text-transform: uppercase; padding: 6px 9px; border-radius: 999px; backdrop-filter: blur(6px); white-space: nowrap; }
.gp-status.live { background: rgba(10,40,20,.6); color: #8ff0a8; }
.gp-status.live::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #5ef08a; margin-right: 6px; vertical-align: 1px; animation: gp-pulse 1.4s ease-in-out infinite; }
.gp-status.early { background: rgba(60,35,0,.65); color: #ffc46b; }
.gp-status.building { color: #1b1400; background: repeating-linear-gradient(-45deg, #ffd23f 0 8px, #ffb000 8px 16px); }
.gp-playing { margin-left: auto; background: var(--c); color: #07080c; box-shadow: 0 0 18px color-mix(in srgb, var(--c) 70%, transparent); }
@keyframes gp-pulse { 50% { opacity: .35; transform: scale(.7); } }
.gp-body { position: absolute; left: 0; right: 0; bottom: 0; min-height: 48%; padding: 0 20px 20px; display: flex; flex-direction: column; gap: 8px; }
.gp-title { font: 900 clamp(22px, 1.9vw, 28px)/1.05 var(--display, "Archivo Expanded", system-ui, sans-serif); letter-spacing: .03em; text-transform: uppercase; color: #fff; overflow-wrap: anywhere; flex: none;
  text-shadow: 0 2px 0 color-mix(in srgb, var(--c) 60%, #000), 0 0 24px color-mix(in srgb, var(--c) 45%, transparent); }
.gp-title.long { font-size: clamp(17px, 1.4vw, 21px); }
.gp-tag { font-size: 13px; line-height: 1.4; color: rgba(255,255,255,.72); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; flex: none; }
.gp-note { font-size: 11px; font-weight: 700; letter-spacing: .06em; color: #ffc46b; flex: none; }
.gp-note.building { color: #ffd23f; }
.gp-who { margin-top: auto; display: flex; flex-wrap: wrap; gap: 5px; align-items: center; min-height: 24px; }
.gp-count { font-weight: 800; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--a); margin-right: 4px; }
.gp-count.none { color: rgba(255,255,255,.4); }
.gp-name { font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 999px; background: rgba(255,255,255,.1); color: #fff; animation: gp-pop .35s cubic-bezier(.3,1.6,.5,1); }
.gp-name.me { background: var(--c); color: #07080c; }
@keyframes gp-pop { from { transform: scale(.4); opacity: 0; } }
.gp button.gp-play { flex: none; width: 100%; border: 0; border-radius: 14px; padding: 15px 0; font: 900 14px/1 var(--display, "Archivo Expanded", system-ui, sans-serif); letter-spacing: .14em; text-transform: uppercase;
  color: #07080c; background: linear-gradient(180deg, color-mix(in srgb, var(--c) 80%, #fff), var(--c)); box-shadow: 0 6px 0 color-mix(in srgb, var(--c) 55%, #000), 0 10px 24px rgba(0,0,0,.4);
  transition: transform .12s ease, box-shadow .12s ease, filter .12s; }
.gp-card.focus button.gp-play:not(:disabled), .gp button.gp-play:hover { filter: brightness(1.08); color: #07080c; background: linear-gradient(180deg, color-mix(in srgb, var(--c) 70%, #fff), var(--c)); }
.gp button.gp-play:hover { transform: translateY(-2px); box-shadow: 0 8px 0 color-mix(in srgb, var(--c) 55%, #000), 0 14px 30px rgba(0,0,0,.45); }
.gp button.gp-play:active { transform: translateY(4px); box-shadow: 0 2px 0 color-mix(in srgb, var(--c) 55%, #000); }
.gp button.gp-play.resume, .gp .gp-card.focus button.gp-play.resume { background: rgba(255,255,255,.1); color: #fff; box-shadow: inset 0 0 0 2px var(--c); }
.gp button.gp-play:disabled { opacity: 1; background: rgba(255,255,255,.07); color: rgba(255,255,255,.45); box-shadow: none; }
.gp-empty { margin: auto; max-width: 420px; text-align: center; font: 700 14px/1.6 var(--display, system-ui); letter-spacing: .1em; text-transform: uppercase; color: rgba(255,255,255,.55); }
.gp-foot { position: relative; display: flex; justify-content: center; gap: 26px; padding: 0 0 26px; font-size: 11px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: rgba(255,255,255,.45); }
.gp-foot span { display: flex; align-items: center; gap: 6px; }
.gp-foot kbd { font-size: 11px; color: rgba(255,255,255,.75); }
@media (max-height: 640px) { .gp-head { padding-top: 24px; } .gp-row { padding-block: 24px; } .gp-foot { padding-bottom: 14px; } }
@media (max-width: 700px) {
  .gp-head { padding: 22px 20px 0; align-items: center; gap: 12px; }
  .gp-logo { font-size: 28px; } .gp-sub { display: none; }
  .gp button.gp-back { min-width: 0; max-width: 62%; padding: 10px 14px; font-size: 11px; }
  .gp-row { gap: 16px; padding: 28px 20px; scroll-snap-type: x mandatory; scroll-padding: 0 20px; -webkit-mask-image: none; mask-image: none; }
  .gp-card { width: min(78vw, 320px); height: clamp(380px, 64vh, 520px); }
  .gp-title { font-size: 26px; } .gp-title.long { font-size: 20px; }
  .gp-foot { display: none; }
}
@media (prefers-reduced-motion: reduce) { .gp-blob, .gp-logo { animation: none; } .gp-card { transition: none; } }

.gp-cover { position: fixed; inset: 0; z-index: 1002; background: #000; opacity: 0; pointer-events: none; transition: opacity ${FADE_MS}ms ease;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #fff; }
.gp-cover.on { opacity: 1; pointer-events: auto; }
.gp-cover.slow { transition-duration: 900ms; }
.gp-cover-title { font: 900 clamp(36px, 7vw, 96px)/1 var(--display, "Archivo Expanded", system-ui, sans-serif); letter-spacing: .08em; text-transform: uppercase; text-align: center; padding: 0 24px;
  text-shadow: 0 0 40px var(--c); opacity: 0; transform: scale(.92); transition: all .7s cubic-bezier(.2,.8,.2,1) .15s; }
.gp-cover-sub { font-weight: 700; font-size: 12px; letter-spacing: .3em; text-transform: uppercase; color: var(--c); opacity: 0; transition: opacity .6s ease .35s; }
.gp-cover.on .gp-cover-title { opacity: 1; transform: none; }
.gp-cover.on .gp-cover-sub { opacity: .9; }
.gp-cover-bar { width: 160px; height: 3px; border-radius: 2px; background: rgba(255,255,255,.12); overflow: hidden; margin-top: 10px; }
.gp-cover-bar i { display: block; height: 100%; width: 40%; background: var(--c); animation: gp-load 1s ease-in-out infinite; }
.gp-cover:not(.on) .gp-cover-bar i { animation-play-state: paused; }
@keyframes gp-load { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
`;
