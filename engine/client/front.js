// The front end shared by the main menu, the join screen and the in-game menu. Loading it turns on arrow-key navigation.

/** The Sandbox mark: block letters on a five by five grid, the O one amber block. */
const LETTERS = {
  S: ".#### #.... .###. ....# ####.",
  A: ".###. #...# ##### #...# #...#",
  N: "#...# ##..# #.#.# #..## #...#",
  D: "####. #...# #...# #...# ####.",
  B: "####. #...# ####. #...# ####.",
  O: "block",
  X: "#...# .#.#. ..#.. .#.#. #...#",
};
export function logo(svg) {
  const cells = [];
  [..."SANDBOX"].forEach((letter, i) => {
    const x0 = i * 6;
    if (LETTERS[letter] === "block") return cells.push(`<rect class="block" x="${x0}" y="0" width="5" height="5"/>`);
    LETTERS[letter].split(" ").forEach((row, y) => [...row].forEach((c, x) => c === "#" && cells.push(`<rect x="${x0 + x + 0.06}" y="${y + 0.06}" width="0.88" height="0.88"/>`)));
  });
  svg.setAttribute("viewBox", "0 0 41 5");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Sandbox");
  svg.innerHTML = cells.join("");
}

/** Clips of games built in Sandbox, crossfading behind the menu: every .mp4 in engine/client/clips, in a shuffled order. The poster paints first; videos load after the page has. */
export function backdrop(el) {
  el.style.backgroundImage = "url(/clips/poster.jpg)";
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const start = async () => {
    const clips = await (await fetch("/clips/")).json().catch(() => []);
    if (!clips.length) return;
    for (let i = clips.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [clips[i], clips[j]] = [clips[j], clips[i]];
    }
    const videos = [0, 1].map(() => Object.assign(document.createElement("video"), { muted: true, playsInline: true, preload: "auto" }));
    el.append(...videos);
    let n = 0;
    const next = () => {
      const video = videos[n % 2];
      const other = videos[(n + 1) % 2];
      video.src = `/clips/${clips[n % clips.length]}`;
      n++;
      video.onplaying = () => {
        video.classList.add("on");
        other.classList.remove("on");
      };
      // The next clip starts while this one still shows, so the fade never passes through black.
      video.ontimeupdate = () => {
        if (video.duration && video.duration - video.currentTime < 1.2 && !video.dataset.handed) {
          video.dataset.handed = "1";
          next();
        }
      };
      delete video.dataset.handed;
      video.play().catch(() => {});
    };
    next();
    document.addEventListener("visibilitychange", () => {
      for (const v of videos) if (v.classList.contains("on")) document.hidden ? v.pause() : v.play().catch(() => {});
    });
  };
  if (document.readyState === "complete") setTimeout(start, 100);
  else addEventListener("load", () => setTimeout(start, 100), { once: true });
}

/** A value picked with the arrows: <div class="pick" data-options="open:Open,additive:Additive">. Its value is in dataset.value. */
export function pick(el, onChange) {
  const options = el.dataset.options.split(",").map((o) => o.split(":"));
  el.tabIndex = 0;
  el.innerHTML = "<i>‹</i><output></output><i>›</i>";
  const show = () => (el.querySelector("output").textContent = options.find(([v]) => v === el.dataset.value)?.[1] ?? "");
  el.dataset.value ??= options[0][0];
  el.step = (by) => {
    const at = options.findIndex(([v]) => v === el.dataset.value);
    el.dataset.value = options[(at + by + options.length) % options.length][0];
    show();
    onChange?.(el.dataset.value);
  };
  el.set = (value) => {
    el.dataset.value = value;
    show();
  };
  const [back, forward] = el.querySelectorAll("i");
  back.onclick = () => el.step(-1);
  forward.onclick = () => el.step(1);
  show();
  return el;
}

const FOCUSABLE = "button, input, select, textarea, a[href], [tabindex='0']";
const shown = (el) => el.getClientRects().length > 0 && !el.disabled && !el.closest("[hidden], [aria-disabled=true]");

/** Up and down move between the controls of the list the focus is in, left and right change a pick, Enter steps it. */
addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const active = document.activeElement;
  if (active?.matches("select, textarea, input[type=number]")) return;
  const lists = [...document.querySelectorAll("[data-nav]")].filter(shown);
  const list = active?.closest("[data-nav]") ?? (active === document.body && lists.length === 1 ? lists[0] : null);
  if (!list || !shown(list)) return;
  if (active?.classList.contains("pick") && ["ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) {
    e.preventDefault();
    return active.step(e.key === "ArrowLeft" ? -1 : 1);
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const controls = [...list.querySelectorAll(FOCUSABLE)].filter((el) => shown(el) && el.closest("[data-nav]") === list && !el.closest(".pick > i"));
  if (!controls.length) return;
  e.preventDefault();
  const at = controls.indexOf(active);
  const next = at < 0 ? controls[0] : controls[(at + (e.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length];
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}, true);

// The mouse moves the focus, so one entry is ever marked; not away from a name being typed.
addEventListener("pointermove", (e) => {
  if (e.pointerType !== "mouse") return;
  const item = e.target.closest?.("[data-nav] button.item");
  if (item && item !== document.activeElement && !document.activeElement?.matches("input[type=text], textarea")) item.focus({ preventScroll: true });
});

const JOIN_CODE = /^[2-9A-HJKMNP-Z]{6}$/;

/** A join entry takes a join code, shown as K7F-M2Q while it is typed, or an invite link, shown as is. */
export function joinEntry(input) {
  const format = () => {
    const raw = input.value;
    const code = !/[:/.]/.test(raw) && raw.replace(/[^a-z0-9]/gi, "").length <= 6;
    if (code) {
      const c = raw.replace(/[^a-z0-9]/gi, "").toUpperCase();
      input.value = c.length > 3 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
    } else if (input.classList.contains("code")) input.value = raw.replace(/^([A-Z0-9]{3})-/, "$1").replace(/^[A-Z0-9-]+/, (s) => s.toLowerCase());
    input.classList.toggle("code", code && !!raw);
  };
  input.addEventListener("input", format);
  input.set = (value) => {
    input.value = value;
    format();
  };
}

/** Where a join entry leads: a link opens as is; a code is looked up on the relay. Throws what to tell the player. */
export async function joinLink(text, relay) {
  const t = text.trim();
  if (/^https?:\/\/\S+$/.test(t)) return t;
  if (/^[\w.-]+(:\d+)?\/r\/[a-z0-9-]+/.test(t)) return `https://${t}`;
  const code = t.replace(/[\s-]/g, "").toUpperCase();
  if (!JOIN_CODE.test(code)) throw new Error("Type the code or paste the link your host sent.");
  const res = await fetch(`${relay}/join/${code}`).catch(() => null);
  if (!res) throw new Error("Can't look up codes right now. Check your connection, or ask for the invite link.");
  const body = await res.json().catch(() => ({ error: `The relay answered ${res.status}.` }));
  if (!res.ok) throw new Error(body.error);
  return body.url;
}

/** Whether copied text is certainly something to join: an invite link, or a code in the K7F-M2Q form the host menu shows. */
export const joinable = (text) => /^https?:\/\/\S+#(invite|key)=\S+$/.test(text) || /^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/i.test(text);
