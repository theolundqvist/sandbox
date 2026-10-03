/**
 * The host's privileged controls inside their game, World (export, stop hosting, rewind), Share (to Community) and the speech key, live in frames on the main menu's own origin (engine/client/host.html).
 * This page, where mods' code runs, never holds the menu's key, the world's host key, a Community owner token or the speech key. It may only ask the frames to join the host into the world running now and to save a picture of it,
 * and hand the Share frame what only the game can make when that frame asks: its view and a clip of its timelapse. Sharing, stopping sharing and every field of what goes up happen in the Share frame alone.
 * It shows the frames only while they keep saying, from that origin, that they are still the controls.
 */

type FromFrame = { host?: unknown; t?: unknown; id?: unknown; hosting?: unknown; height?: unknown; text?: unknown; kind?: unknown; code?: unknown; key?: unknown; name?: unknown; error?: unknown; password?: unknown };
type View = "world" | "share" | "voice";
const TITLES: Record<View, string> = { world: "World", share: "Share", voice: "Voice key" };
/** A frame of controls: when it last said it is them, since when its page shows, and since when it should take the keyboard once it shows. */
type Frame = { view: View; el: HTMLIFrameElement; src: string; beat: number; shownAt: number; focusAt: number };

export type HostControls = {
  /** Joins the world running now as its host: by this computer's key, or by a name, which comes back to the host from another computer without asking. */
  join(body: { key: string } | { name: string; password?: string }): Promise<{ key: string; name: string }>;
  /** Saves a JPEG of the host's view as the running world's picture; settles once saved, or after a moment either way. */
  cover(jpeg: Uint8Array<ArrayBuffer>): Promise<void>;
  /** The World page opened: the frame shows the saved moments as they are now. */
  show(): void;
  /** The Share page opened: the frame shows how the world is shared now, offering `about` for a world not shared yet. */
  showShare(about: string): void;
  /** Moves the keyboard into this frame of controls as soon as it shows them; false for any other element. */
  focus(el: Element): boolean;
};

/** The controls of a host playing at localhost on their own computer, or null for anyone else, a world run without a launcher, or a launcher hosting another world. */
export async function hostControls(o: {
  world: string;
  worldPage: HTMLElement;
  sharePage: HTMLElement;
  voiceBefore: HTMLElement;
  toast(text: string, kind: string): void;
  /** Esc, Tab, or left outside a field, pressed in a frame, for the menu around it. */
  key(code: string): void;
  /** Stop hosting was confirmed: the world's last picture goes now, while it still runs to take it. */
  stopping(): void;
  stopped(): void;
  /** Share was pressed in the World frame: open the Share page. */
  share(): void;
  /** The host's view now, as a JPEG, for the Share frame's Current view. */
  view(): Uint8Array<ArrayBuffer>;
  /** A clip of the timelapse, recorded in the game for the Share frame; null when there is nothing to replay yet. */
  clip(): Promise<Blob | null>;
}): Promise<HostControls | null> {
  // Players at a LAN address or through the relay are on another computer: the main menu at 127.0.0.1 is never theirs to frame.
  if (location.hostname !== "localhost") return null;
  const menu = `http://127.0.0.1:${location.port}`;
  const frames: Frame[] = [];
  const waiting = new Map<number, (msg: FromFrame) => void>();
  let seq = 0;
  const known = Promise.withResolvers<boolean>();
  /** The World frame's page is the launcher's controls, still asking whose world this is. */
  let answering = false;
  /** What the game offered as About when it last opened the Share page, for a Share frame that loads after it did; null before it ever has. */
  let shareAbout: string | null = null;
  const post = (f: Frame, msg: object, transfer: Transferable[] = []) => f.el.contentWindow?.postMessage(msg, menu, transfer);
  const layout = () => {
    for (const f of frames) post(f, { t: "layout", narrow: innerWidth <= 760 });
  };
  function frame(view: View, place: (el: HTMLIFrameElement) => void) {
    // An out-of-process menu frame does not inherit Electron's custom user agent; this only chooses how provider links open.
    const src = `${menu}/host?view=${view}&world=${encodeURIComponent(o.world)}${navigator.userAgent.includes("SandboxDesktop") ? "&desktop=1" : ""}`;
    const el = Object.assign(document.createElement("iframe"), { src, title: TITLES[view] });
    // Share copies its link from inside the frame.
    if (view === "share") el.allow = "clipboard-write";
    el.style.cssText = "display: block; width: 100%; height: 0; border: 0; visibility: hidden";
    const f: Frame = { view, el, src, beat: 0, shownAt: 0, focusAt: 0 };
    el.addEventListener("focus", () => post(f, { t: "focus" }));
    frames.push(f);
    place(el);
    return f;
  }

  // First in line, so mods' listeners don't mistake the frames' messages for their own. Nothing in them is secret: this page holds no more than it could ask for.
  addEventListener(
    "message",
    (e) => {
      const f = frames.find((x) => e.source === x.el.contentWindow);
      if (!f) return;
      e.stopImmediatePropagation();
      const msg = e.data as FromFrame | null;
      if (e.origin !== menu || typeof msg !== "object" || msg?.host !== f.view) return;
      if (msg.t === "hello") answering = true;
      else if (msg.t === "ready") {
        if (f.view === "world") known.resolve(msg.hosting === true);
        if (f.view === "share" && shareAbout !== null) post(f, { t: "show", about: shareAbout });
        layout();
      } else if (msg.t === "beat") {
        f.beat = performance.now();
        f.el.style.visibility = "visible";
        if (f.beat - f.focusAt < 3000) f.el.focus();
        f.focusAt = 0;
      } else if (msg.t === "gone") {
        f.beat = 0;
        f.el.style.visibility = "hidden";
      } else if (msg.t === "size") f.el.style.height = `${Math.ceil(Number(msg.height) || 0)}px`;
      else if (msg.t === "toast") o.toast(String(msg.text).slice(0, 300), msg.kind === "error" ? "error" : "info");
      else if (msg.t === "key" && (msg.code === "Escape" || msg.code === "Tab" || msg.code === "ArrowLeft")) o.key(msg.code);
      else if ((msg.t === "joined" || msg.t === "covered") && typeof msg.id === "number") waiting.get(msg.id)?.(msg);
      else if (msg.t === "stopping" && f.view === "world") o.stopping();
      else if (msg.t === "stopped" && f.view === "world") o.stopped();
      else if (msg.t === "share" && f.view === "world") o.share();
      else if (msg.t === "view" && f.view === "share" && typeof msg.id === "number") {
        const jpeg = o.view();
        post(f, { t: "view", id: msg.id, jpeg }, [jpeg.buffer]);
      } else if (msg.t === "clip" && f.view === "share" && typeof msg.id === "number") {
        const id = msg.id;
        void o
          .clip()
          .then((clip) => clip?.arrayBuffer() ?? null)
          .catch(() => null)
          .then((webm) => post(f, { t: "clip", id, webm: webm && new Uint8Array(webm) }, webm ? [webm] : []));
      }
    },
    true,
  );

  const world = frame("world", (el) => o.worldPage.prepend(el));
  // A world server run without a launcher answers that address itself, with a page that never says hello: once it is in, the frame has a moment to.
  world.el.addEventListener("load", () => setTimeout(() => answering || known.resolve(false), 1500), { once: true });
  setTimeout(() => known.resolve(false), 10_000);
  if (!(await known.promise)) {
    world.el.remove();
    frames.length = 0;
    return null;
  }
  const share = frame("share", (el) => o.sharePage.prepend(el));
  frame("voice", (el) => o.voiceBefore.before(el));
  addEventListener("resize", layout);
  // A frame navigated elsewhere goes quiet: hidden at once, and sent back to the controls once its page has shown a while without them.
  setInterval(() => {
    const now = performance.now();
    for (const f of frames) {
      if (now - f.beat > 1500) f.el.style.visibility = "hidden";
      if (!f.el.getClientRects().length) f.shownAt = 0;
      else if (!f.shownAt) f.shownAt = now;
      else if (now - Math.max(f.beat, f.shownAt) > 3000) {
        f.shownAt = now;
        f.el.src = f.src;
      }
    }
  }, 500);

  /** Asks the World frame for something; its answer, or null once `ms` pass without one. */
  async function ask(msg: object, ms: number, transfer: Transferable[] = []) {
    const id = ++seq;
    const answer = Promise.withResolvers<FromFrame | null>();
    const timer = setTimeout(() => answer.resolve(null), ms);
    waiting.set(id, answer.resolve);
    post(world, { ...msg, id }, transfer);
    try {
      return await answer.promise;
    } finally {
      clearTimeout(timer);
      waiting.delete(id);
    }
  }

  return {
    async join(body) {
      // The world may ask its host's game who this is for up to a minute.
      const msg = await ask({ t: "join", ...body }, 75_000);
      if (typeof msg?.key === "string") return { key: msg.key, name: String(msg.name) };
      throw Object.assign(new Error(typeof msg?.error === "string" ? msg.error : "The host's controls didn't answer. Try again."), { password: msg?.password === true });
    },
    async cover(jpeg) {
      await ask({ t: "cover", jpeg }, 1500, [jpeg.buffer]);
    },
    show: () => post(world, { t: "show" }),
    showShare(about) {
      shareAbout = about;
      post(share, { t: "show", about });
    },
    focus(el) {
      const f = frames.find((x) => x.el === el);
      if (!f) return false;
      f.focusAt = performance.now();
      if (f.el.style.visibility === "visible") f.el.focus();
      return true;
    },
  };
}
