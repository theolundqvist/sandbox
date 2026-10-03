// The public face of Sandbox: join a friend's world, browse Community worlds, get the app. Every screen has its own address; a world's is /w/<id>.
import { COMPUTERS, backdrop, computer, computerPick, joinLink, logo, usage } from "/front.js";

const API = "https://sandbox.api.lundqvistliss.com";

const $ = (id) => document.getElementById(id);
const el = (tag, props, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

/** Usage stats under an anonymous id this browser keeps, unless the visitor turned Share usage stats off; storage that can't be used means no stats. */
const stored = (key, value) => {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const anon = stored("sandbox-anon") ?? stored("sandbox-anon", crypto.randomUUID());
const sharing = () => stored("sandbox-usage") !== "off";
// Plain text, so no preflight, and keepalive, so the last batch outlives the page.
const stats = usage("site", (events) => anon && sharing() && fetch(`${API}/events`, { method: "POST", keepalive: true, body: JSON.stringify({ anon, events, app: { os: computer } }) }).catch(() => {}));
const showSharing = () => ($("share-usage").textContent = `Share usage stats: ${sharing() ? "On" : "Off"}`);
logo($("logo"));
showSharing();
$("share-usage").onclick = () => {
  stored("sandbox-usage", sharing() ? "off" : "on");
  showSharing();
};

backdrop($("backdrop"));

/** Host: the install line for the picked computer, the visitor's own first. */
const INSTALLER = "https://raw.githubusercontent.com/theolundqvist/sandbox/master/desktop/install";
computerPick($("host-os"), (os) => {
  $("host-open").textContent = COMPUTERS[os].open;
  $("install").textContent = os === "windows" ? `irm ${INSTALLER}.ps1 | iex` : `curl -fsSL ${INSTALLER} | bash`;
  $("mac-blocked").hidden = $("mac-steps").hidden = os !== "mac";
});

const media = (w) => (w.clip ? el("video", { src: w.clip, poster: w.cover, muted: true, loop: true, autoplay: true, playsInline: true }) : el("img", { src: w.cover, alt: "" }));
/** The API with the visitor's session cookie, which only the API can read; its header tells the API the request comes from this site. */
const api = async (path, init = {}) => {
  const res = await fetch(`${API}${path}`, { ...init, credentials: "include", headers: { "x-sandbox": "1", ...(init.body && { "content-type": "application/json" }) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Community can't be reached right now.");
  return data;
};
/** Playing or forking happens in the app: the world's link goes on the clipboard to paste there. */
async function copyFor(w, tip) {
  await navigator.clipboard?.writeText(w.link).catch(() => {});
  tip.hidden = false;
}

/** A world as a row: its clip, its name, who made it, and the link to play or fork it in the app. */
function worldRow(w) {
  const get = el("button", { className: "quiet", textContent: "Play or fork it in the app" });
  get.dataset.event = "world-get";
  const about = w.visibility === "link" ? "link only" : w.votes === 1 ? "1 vote" : `${w.votes} votes`;
  const row = el("a", { className: "world", href: `/w/${w.id}` }, el("span", { className: "cover" }, media(w)), el("span", { className: "what" }, el("b", { textContent: w.title }), el("small", { textContent: `by ${w.author} · ${about}` }), get));
  get.onclick = (e) => {
    e.preventDefault();
    copyFor(w, $("world-tip"));
    get.textContent = "Link copied: paste it in Worlds, Community";
  };
  return row;
}

let listed = [];
async function showWorlds(more = false) {
  if (!more) listed = [];
  $("empty").hidden = !!listed.length;
  $("empty").textContent = "Loading";
  const page = await api(`/worlds${more && listed.length ? `?after=${listed.at(-1).id}` : ""}`);
  listed.push(...page);
  $("empty").textContent = "No worlds shared yet";
  $("empty").hidden = !!listed.length;
  $("more").hidden = page.length < 50;
  $("world-list").replaceChildren(...listed.map(worldRow));
}
$("more").onclick = () => showWorlds(true).catch((e) => ($("error").textContent = e.message));

async function showWorld(id) {
  const w = await api(`/worlds/${id}`);
  document.title = `${w.title} · Sandbox`;
  $("world-stage").replaceChildren(media(w));
  $("world-title").textContent = w.title;
  $("world-by").textContent = [`by ${w.author}`, w.mods ? `${w.mods} mods` : ""].filter(Boolean).join(" · ");
  $("world-about").textContent = w.description;
  $("world-tip").hidden = true;
  $("world-get").onclick = () => copyFor(w, $("world-tip"));
  const showVote = () => {
    $("vote").firstChild.textContent = w.voted ? "Upvoted" : "Upvote";
    $("votes").textContent = String(w.votes);
  };
  showVote();
  // Voting needs an account: signing in comes back here.
  $("vote").onclick = async () => {
    if (!(await whoAmI())) return go(`/signin?then=/w/${id}`);
    try {
      Object.assign(w, await api(`/worlds/${id}/vote`, { method: "PUT", body: JSON.stringify({ up: !w.voted }) }));
      showVote();
    } catch (e) {
      $("error").textContent = e.message;
    }
  };
  $("report").hidden = w.mine;
  $("report").disabled = false;
  $("report").textContent = "Report";
  $("report").onclick = async () => {
    $("report").disabled = true;
    await api(`/worlds/${id}/report`, { method: "POST" }).catch(() => {});
    $("report").textContent = "Reported. Thanks";
  };
  $("take-down").hidden = !w.mine;
  $("take-down").textContent = "Take down";
  $("take-down").onclick = async () => {
    if ($("take-down").textContent === "Take down") return void ($("take-down").textContent = "Take down for everyone?");
    try {
      await api(`/worlds/${id}`, { method: "DELETE" });
    } catch (e) {
      return void ($("error").textContent = e.message);
    }
    go("/account");
  };
}

/** Who is signed in, asked once per page load and after signing in or out. */
let account;
async function whoAmI(fresh = false) {
  if (fresh || account === undefined) account = (await api("/account").catch(() => ({}))).account ?? null;
  $("me").hidden = false;
  $("me").textContent = account ? account.username : "Sign in";
  return account;
}
const go = (path) => {
  history.pushState(null, "", path);
  route();
};
/** Where to carry on after signing in: the page that asked for it. */
const then = () => new URLSearchParams(location.search).get("then")?.match(/^\/[a-z0-9/]*$/)?.[0] ?? "/account";
async function enterAccount(path, body) {
  $("error").textContent = "";
  try {
    await api(path, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    return void ($("error").textContent = e.message);
  }
  for (const input of document.querySelectorAll("input[type=password]")) input.value = "";
  await whoAmI(true);
  go(then());
}
$("signin-form").onsubmit = (e) => {
  e.preventDefault();
  enterAccount("/sessions", { email: $("signin-email").value, password: $("signin-password").value });
};
$("signup-form").onsubmit = (e) => {
  e.preventDefault();
  enterAccount("/accounts", { username: $("signup-username").value, email: $("signup-email").value, password: $("signup-password").value });
};
$("sign-out").onclick = async () => {
  await api("/sessions", { method: "DELETE" }).catch(() => {});
  await whoAmI(true);
  go("/");
};
$("delete-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api("/account", { method: "DELETE", body: JSON.stringify({ password: $("delete-password").value }) });
  } catch (err) {
    return void ($("error").textContent = err.message);
  }
  $("delete-password").value = "";
  await whoAmI(true);
  go("/");
};
async function showAccount() {
  if (!(await whoAmI())) return go("/signin");
  $("account-name").textContent = account.username;
  const mine = await api("/account/worlds");
  $("my-worlds").replaceChildren(...mine.map(worldRow));
  $("my-none").hidden = !!mine.length;
}

const SCREENS = { "/": "home", "/join": "join", "/worlds": "worlds", "/host": "host", "/signin": "signin", "/signup": "signup", "/account": "account", "/account/delete": "delete" };
const BACK = { world: "/worlds", signup: "/signin", delete: "/account" };
async function route() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const id = path.match(/^\/w\/([a-z0-9]{12})$/)?.[1];
  const screen = id ? "world" : (SCREENS[path] ?? "home");
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== screen;
  stats.screen(screen);
  $("back").hidden = screen === "home";
  $("back").href = BACK[screen] ?? "/";
  $("go-signup").search = location.search;
  $("error").textContent = "";
  document.title = "Sandbox";
  try {
    if (screen === "worlds") await showWorlds();
    if (screen === "world") await showWorld(id);
    if (screen === "account") await showAccount();
    if (screen === "delete" && !(await whoAmI())) return go("/signin");
  } catch (e) {
    $("error").textContent = e.message;
  }
  if (screen === "join") $("join-link").focus();
  $("me").hidden = screen === "home" || screen === "signin" || screen === "signup";
  if (!$("me").hidden) whoAmI();
}

// Links between screens change the address without reloading the page.
addEventListener("click", (e) => {
  const a = e.target.closest?.("a[href^='/'], a#go-signup");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.defaultPrevented) return;
  e.preventDefault();
  history.pushState(null, "", a.pathname + a.search);
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
    const link = joinLink($("join-link").value);
    stats.step("join");
    location.assign(link);
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
