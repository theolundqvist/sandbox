// The public face of Sandbox: join a friend's world, browse Community worlds, get the app. Every screen has its own address; a world's is /w/<id>.
import { COMPUTERS, backdrop, computerPick, joinLink, logo } from "/front.js";

const API = "https://sandbox.api.lundqvistliss.com";
const $ = (id) => document.getElementById(id);
const el = (tag, props, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
logo($("logo"));

backdrop($("backdrop"));

/** Host: the install line for the picked computer, the visitor's own first. */
const INSTALLER = "https://raw.githubusercontent.com/theolundqvist/sandbox/master/desktop/install";
computerPick($("host-os"), (os) => {
  $("host-open").textContent = COMPUTERS[os].open;
  $("install").textContent = os === "windows" ? `irm ${INSTALLER}.ps1 | iex` : `curl -fsSL ${INSTALLER} | bash`;
  $("mac-blocked").hidden = $("mac-steps").hidden = os !== "mac";
});

const media = (w) => (w.clip ? el("video", { src: w.clip, poster: w.cover, muted: true, loop: true, autoplay: true, playsInline: true }) : el("img", { src: w.cover, alt: "" }));
const api = async (path, init) => {
  const res = await fetch(`${API}${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Community can't be reached right now.");
  return data;
};
/** Hosting or remixing happens in the app: the world's link goes on the clipboard to paste there. */
async function copyFor(w, tip) {
  await navigator.clipboard?.writeText(w.link).catch(() => {});
  tip.hidden = false;
}

async function showWorlds() {
  $("empty").hidden = false;
  $("empty").textContent = "Loading";
  const list = await api("/worlds");
  $("empty").textContent = "No worlds shared yet";
  $("empty").hidden = !!list.length;
  $("world-list").replaceChildren(
    ...list.map((w) => {
      const get = el("button", { className: "quiet", textContent: "Host or remix it in the app" });
      const row = el("a", { className: "world", href: `/w/${w.id}` }, el("span", { className: "cover" }, media(w)), el("span", { className: "what" }, el("b", { textContent: w.title }), el("small", { textContent: `by ${w.author}` }), get));
      get.onclick = (e) => {
        e.preventDefault();
        copyFor(w, $("world-tip"));
        get.textContent = "Link copied: paste it in Worlds, Community";
      };
      return row;
    }),
  );
}

async function showWorld(id) {
  const w = await api(`/worlds/${id}`);
  document.title = `${w.title} · Sandbox`;
  $("world-stage").replaceChildren(media(w));
  $("world-title").textContent = w.title;
  $("world-by").textContent = [`by ${w.author}`, w.mods ? `${w.mods} mods` : ""].filter(Boolean).join(" · ");
  $("world-about").textContent = w.description;
  $("world-tip").hidden = true;
  $("world-get").onclick = () => copyFor(w, $("world-tip"));
  $("report").disabled = false;
  $("report").textContent = "Report";
  $("report").onclick = async () => {
    $("report").disabled = true;
    await api(`/worlds/${id}/report`, { method: "POST" }).catch(() => {});
    $("report").textContent = "Reported. Thanks";
  };
}

const SCREENS = { "/": "home", "/join": "join", "/worlds": "worlds", "/host": "host" };
async function route() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const id = path.match(/^\/w\/([a-z0-9]{12})$/)?.[1];
  const screen = id ? "world" : (SCREENS[path] ?? "home");
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== screen;
  $("back").hidden = screen === "home";
  $("back").href = id ? "/worlds" : "/";
  $("error").textContent = "";
  document.title = "Sandbox";
  try {
    if (screen === "worlds") await showWorlds();
    if (screen === "world") await showWorld(id);
  } catch (e) {
    $("error").textContent = e.message;
  }
  if (screen === "join") $("join-link").focus();
}

// Links between screens change the address without reloading the page.
addEventListener("click", (e) => {
  const a = e.target.closest?.("a[href^='/']");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.defaultPrevented) return;
  e.preventDefault();
  history.pushState(null, "", a.getAttribute("href"));
  scrollTo(0, 0);
  route();
});
addEventListener("popstate", route);
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("back").hidden) $("back").click();
});

$("join-form").onsubmit = (e) => {
  e.preventDefault();
  try {
    location.assign(joinLink($("join-link").value));
  } catch (err) {
    $("join-error").textContent = err.message;
  }
};
for (const button of document.querySelectorAll("[data-copy]"))
  button.onclick = async () => {
    await navigator.clipboard?.writeText($(button.dataset.copy).textContent);
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1500);
  };

route();
