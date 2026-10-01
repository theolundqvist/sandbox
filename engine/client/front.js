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
  const options = el.choices ?? el.dataset.options.split(",").map((o) => o.split(":"));
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
/** Shadow roots whose lists move with the keys too: the game's own UI, a closed root the game hands over. */
const shadows = [];
export function navigateIn(root) {
  shadows.push(root);
  root.addEventListener("pointermove", hover);
}
const focused = () => shadows.find((root) => root.activeElement)?.activeElement ?? document.activeElement;
/** What the page slots into a shadow root's list: mods' blocks on the game menu's pages. */
const slotted = (list) => [...list.querySelectorAll("slot")].flatMap((slot) => slot.assignedElements());
const listOf = (el) => el?.closest("[data-nav]") ?? shadows.flatMap((root) => [...root.querySelectorAll("[data-nav]")]).find((list) => slotted(list).some((block) => block.contains(el)));
const shown = (el) => el.getClientRects().length > 0 && !el.disabled && !el.closest("[hidden], [aria-disabled=true]");

/** Up and down move between the controls of the list the focus is in, left and right change a pick, Enter steps it. */
addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const active = focused();
  if (active?.matches("select, textarea, input[type=number]")) return;
  const lists = [document, ...shadows].flatMap((root) => [...root.querySelectorAll("[data-nav]")]).filter(shown);
  const list = listOf(active) ?? (active === document.body && lists.length === 1 ? lists[0] : null);
  if (!list || !shown(list)) return;
  if (active?.classList.contains("pick") && ["ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) {
    e.preventDefault();
    return active.step(e.key === "ArrowLeft" ? -1 : 1);
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const controls = [...list.querySelectorAll(FOCUSABLE), ...slotted(list).flatMap((block) => [...block.querySelectorAll(FOCUSABLE)])].filter((el) => shown(el) && listOf(el) === list && !el.closest(".pick > i"));
  if (!controls.length) return;
  e.preventDefault();
  const at = controls.indexOf(active);
  const next = at < 0 ? controls[0] : controls[(at + (e.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length];
  next.focus();
  next.scrollIntoView({ block: "nearest" });
}, true);

// The mouse moves the focus, so one entry is ever marked; not away from a name being typed, and not by a window opening under a still mouse.
function hover(e) {
  if (e.pointerType !== "mouse" || (!e.movementX && !e.movementY)) return;
  const item = e.target.closest?.("[data-nav] button.item");
  if (item && item !== focused() && !focused()?.matches("input[type=text], textarea")) item.focus({ preventScroll: true });
}
addEventListener("pointermove", hover);

/** Where a pasted invite leads: the link as is, with https:// added to a relay link copied without it. Throws what to tell the player. */
export function joinLink(text) {
  const t = text.trim();
  if (/^https?:\/\/\S+$/.test(t)) return t;
  if (/^[\w.-]+(:\d+)?\/r\/[a-z0-9-]+/.test(t)) return `https://${t}`;
  throw new Error("Paste the invite link your host sent.");
}

/** Whether copied text is certainly an invite link. */
export const joinable = (text) => /^https?:\/\/\S+#(invite|key)=\S+$/.test(text);

const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
/** The visitor's computer, picked first wherever the steps differ between computers; Windows when it can't tell. */
export const computer = /mac/i.test(platform) ? "mac" : /linux|x11|cros/i.test(platform) ? "linux" : "windows";

/** Each computer, and how someone who has never used a terminal opens one there. */
export const COMPUTERS = {
  windows: { name: "Windows", open: "Press the Windows key, type PowerShell, press Enter." },
  mac: { name: "Mac", open: "Press Cmd+Space, type Terminal, press Enter." },
  linux: { name: "Linux", open: "Press Ctrl+Alt+T." },
};

/** A pick of computers, starting on the visitor's; onChange runs for that one too. */
export function computerPick(el, onChange) {
  el.choices = Object.entries(COMPUTERS).map(([id, c]) => [id, c.name]);
  el.dataset.value = computer;
  pick(el, onChange);
  onChange(computer);
}
