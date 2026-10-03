// The public face of Sandbox: join a friend's world, browse Community worlds and mods, get the app. Every screen has its own address; a world's is /w/<id>, a mod's /m/<id>.
import { COMPUTERS, backdrop, computer, computerPick, joinLink, logo, pick, usage } from "/front.js";

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

const counted = (n, what) => `${n} ${what}${n === 1 ? "" : "s"}`;
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : Math.round(m / 1440) === 1 ? "yesterday" : `${Math.round(m / 1440)} days ago`;
};

const pageOf = (w) => `/${w.kind === "mod" ? "m" : "w"}/${w.id}`;
/** A world as a row: its clip, its name, who made it, and the link to play or fork it in the app. A mod's row says how many worlds use it instead. */
function worldRow(w) {
  if (w.kind === "mod") return el("a", { className: "world", href: pageOf(w) }, el("span", { className: "cover" }, media(w)), el("span", { className: "what" }, el("b", { textContent: w.title }), el("small", { textContent: `by ${w.author} · ${counted(w.uses, "world")} use it · ${counted(w.votes, "vote")}` }), el("small", { textContent: w.description })));
  const get = el("button", { className: "quiet", textContent: "Play or fork it in the app" });
  get.dataset.event = "world-get";
  const about = w.visibility === "link" ? "link only" : `${counted(w.players, "player")} · ${counted(w.plays, "play")} · ${counted(w.votes, "vote")}`;
  const row = el("a", { className: "world", href: pageOf(w) }, el("span", { className: "cover" }, media(w)), el("span", { className: "what" }, el("b", { textContent: w.title }), el("small", { textContent: `by ${w.author} · ${about}` }), get));
  get.onclick = (e) => {
    e.preventDefault();
    copyFor(w, $("world-tip"));
    get.textContent = "Link copied: paste it in Worlds, Community";
  };
  return row;
}

/** Worlds hosted right now: anyone's, the visitor's friends', and those behind a password, which only the world's relay checks. */
const LOCK = '<svg class="lock" viewBox="0 0 12 14" aria-label="Password"><path d="M3 6V4a3 3 0 0 1 6 0v2h1.5v8h-9V6zm1.5 0h3V4a1.5 1.5 0 0 0-3 0z"/></svg>';
async function showLive() {
  const rows = await api("/live").catch(() => []);
  $("live-list").replaceChildren(...rows.map(liveRow));
}
function liveRow(w) {
  const playing = el("span", { className: "playing", textContent: `${w.players} playing` });
  const locked = w.access === "password";
  const row = el(locked ? "div" : "a", locked ? { className: "world", tabIndex: 0 } : { className: "world", href: w.link }, el("span", { className: "what" }, el("b", { textContent: w.title }), el("small", { textContent: `${w.access === "friends" ? "Friends · " : ""}hosted by ${w.host}` })), playing);
  row.dataset.event = "live-join";
  if (!locked) return row;
  playing.insertAdjacentHTML("beforeend", LOCK);
  const input = el("input", { type: "password", placeholder: "Password", maxLength: 40, autocomplete: "off" });
  const error = el("div", { className: "error" });
  const form = el("form", { className: "unlock", hidden: true }, el("label", { className: "item entry" }, input), error);
  row.append(form);
  const ask = () => {
    if (!form.hidden) return;
    form.hidden = false;
    input.focus();
  };
  row.onclick = ask;
  row.onkeydown = (e) => {
    if (e.key === "Enter" && e.target === row) ask();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const res = await fetch(`${new URL(w.link).origin}/_unlock`, { method: "POST", body: JSON.stringify({ room: w.room, password: input.value }) }).catch(() => null);
    const data = await res?.json().catch(() => ({}));
    if (res?.ok) return location.assign(`${w.link}#invite=${data.invite}`);
    error.textContent = data?.error ?? "The world didn't answer.";
  };
  return row;
}

let listed = [];
async function showWorlds(more = false) {
  if (!more) listed = [];
  $("empty").hidden = !!listed.length;
  $("empty").textContent = "Loading";
  const mods = $("world-sort").dataset.value === "mods";
  $("mods-search-form").hidden = !mods;
  const after = more && listed.length ? `&after=${listed.at(-1).id}` : "";
  const page = await api(mods ? `/mods?q=${encodeURIComponent($("mods-search").value)}${after}` : `/worlds?sort=${$("world-sort").dataset.value}${after}`);
  listed.push(...page);
  $("empty").textContent = mods ? ($("mods-search").value.trim() ? "No mods match" : "No mods shared yet") : "No worlds shared yet";
  $("empty").hidden = !!listed.length;
  $("more").hidden = page.length < 50;
  $("world-list").replaceChildren(...listed.map(worldRow));
}
pick($("world-sort"), () => showWorlds().catch((e) => ($("error").textContent = e.message)));
$("more").onclick = () => showWorlds(true).catch((e) => ($("error").textContent = e.message));
let searching;
$("mods-search").oninput = () => {
  clearTimeout(searching);
  searching = setTimeout(() => showWorlds().catch((e) => ($("error").textContent = e.message)), 250);
};
$("mods-search-form").onsubmit = (e) => e.preventDefault();

/** A world's page, or a mod's: a mod is added by an agent rather than played, so it shows its README, its API and the line that adds it. */
async function showWorld(id, kind = "world") {
  const mod = kind === "mod";
  const w = await api(mod ? `/mods/${id}` : `/worlds/${id}`);
  const here = pageOf(w);
  document.title = `${w.title} · Sandbox`;
  $("world-stage").replaceChildren(media(w));
  $("world-title").textContent = w.title;
  const names = w.builders ?? [w.author];
  const counts = mod ? ["", `${counted(w.uses, "world")} use it`] : ["", counted(w.players, "player"), counted(w.plays, "play"), w.mods ? `${w.mods} mods` : ""];
  $("world-by").replaceChildren("by ", ...names.flatMap((n, i) => [i ? ", " : "", el("a", { href: `/u/${n}`, textContent: n })]), counts.filter((x, i) => !i || x).join(" · "));
  $("world-get").hidden = mod;
  $("mod-part").hidden = !mod;
  $("mod-add").textContent = `./world add_mod id=${w.id}`;
  $("mod-readme").textContent = w.readme ?? "";
  $("mod-readme").hidden = !w.readme;
  $("mod-api").textContent = w.api || "Exports nothing to other mods";
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
    if (!(await whoAmI())) return go(`/signin?then=${here}`);
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
  const parent = w.parent;
  $("world-parent").hidden = !parent;
  $("world-parent").replaceChildren(
    "Forked from ",
    parent?.id ? el("a", { href: `/${mod ? "m" : "w"}/${parent.id}`, textContent: `${parent.title} by ${parent.author}` }) : `${parent?.removed ? "a removed" : "an unlisted"} ${kind}`,
  );
  await Promise.all([showForks(id, w.forks), showComments(id, false, here)]);
}

/** The listed worlds forked from this one, newest first. */
let forks = [];
async function showForks(id, count, more = false) {
  if (!more) forks = [];
  $("forks-part").hidden = !count;
  if (!count) return;
  const page = await api(`/worlds/${id}/forks${more && forks.length ? `?after=${forks.at(-1).id}` : ""}`);
  forks.push(...page);
  $("forks-more").hidden = page.length < 50;
  $("forks-more").onclick = () => showForks(id, count, true).catch((e) => ($("error").textContent = e.message));
  $("fork-list").replaceChildren(...forks.map(worldRow));
}

/** A world's comments, oldest first, 100 at a time. Their author and the world's owner remove them; anyone reports them. */
let thread = [];
async function showComments(id, more = false, here = `/w/${id}`) {
  if (!more) thread = [];
  const signedIn = !!(await whoAmI());
  $("comment-form").hidden = !signedIn;
  $("comment-signin").hidden = signedIn;
  $("comment-signin").href = `/signin?then=${here}`;
  const page = await api(`/worlds/${id}/comments${more && thread.length ? `?after=${thread.at(-1).id}` : ""}`);
  thread.push(...page);
  $("comments-more").hidden = page.length < 100;
  $("comments-more").onclick = () => showComments(id, true, here).catch((e) => ($("error").textContent = e.message));
  $("comment-form").onsubmit = async (e) => {
    e.preventDefault();
    const body = $("comment-text").value.trim();
    if (!body) return;
    try {
      thread.push(await api(`/worlds/${id}/comments`, { method: "POST", body: JSON.stringify({ body }) }));
    } catch (err) {
      return void ($("error").textContent = err.message);
    }
    $("comment-text").value = "";
    renderComments();
  };
  renderComments();
}
function renderComments() {
  $("comments-none").hidden = thread.length > 0;
  $("comment-list").replaceChildren(
    ...thread.map((c) => {
      const head = el("small", { textContent: `${c.author} · ${ago(c.at)}` });
      const act = (text, run) => head.appendChild(el("button", { className: "quiet", textContent: text, onclick: run }));
      if (c.canRemove)
        act("Remove", async () => {
          try {
            await api(`/comments/${c.id}`, { method: "DELETE" });
          } catch (e) {
            return void ($("error").textContent = e.message);
          }
          Object.assign(c, { removed: true, body: "", canRemove: false });
          renderComments();
        });
      if (!c.mine && !c.removed)
        act("Report", async (e) => {
          e.target.disabled = true;
          await api(`/comments/${c.id}/report`, { method: "POST" }).catch(() => {});
          e.target.textContent = "Reported";
        });
      return el("div", { className: c.removed ? "comment removed" : "comment" }, head, el("p", { textContent: c.removed ? "Removed" : c.body }));
    }),
  );
}

/** Who is signed in, asked once per page load and after signing in or out. */
let account;
async function whoAmI(fresh = false) {
  if (fresh || account === undefined) account = (await api("/account").catch(() => ({}))).account ?? null;
  $("me").hidden = false;
  $("me").textContent = account ? account.username : "Sign in";
  $("bell").hidden = !account;
  if (account) api("/account/unread").then((u) => ($("bell-count").textContent = u.notifications ? String(u.notifications) : ""), () => {});
  return account;
}

/** What a notice says, and where it leads. */
const NOTICES = {
  fork: (n) => [`${n.actor} forked your ${n.world.kind}`, n.world.title, pageOf(n.world)],
  comment: (n) => [`${n.actor} commented`, n.world.title, pageOf(n.world)],
  message: (n) => [`${n.actor} sent you a message`, "", `/messages/${n.actor}`],
  credit: (n) => [`${n.actor} credited you`, `${n.world.title} · accept it in the app`, `/w/${n.world.id}`],
  "friend-request": (n) => [`${n.actor} wants to be friends`, "", `/u/${n.actor}`],
  "friend-accepted": (n) => [`${n.actor} is your friend now`, "", `/u/${n.actor}`],
};
async function showNotices() {
  if (!(await whoAmI())) return go("/signin?then=/notifications");
  const list = await api("/notifications");
  $("notices-none").hidden = list.length > 0;
  $("notice-list").replaceChildren(
    ...list.map((n) => {
      const [what, about, href] = NOTICES[n.kind](n);
      return el("a", { className: "world", href }, el("span", { className: "what" }, el("b", { textContent: what }), el("small", { textContent: about })), el("span", { className: n.read ? "when" : "playing", textContent: n.read ? ago(n.at) : "New" }));
    }),
  );
  if (list.some((n) => !n.read)) await api("/notifications/read", { method: "POST" }).then(() => ($("bell-count").textContent = ""), () => {});
}
const go = (path) => {
  history.pushState(null, "", path);
  route();
};
/** Where to carry on after signing in: the page that asked for it. */
const then = () => new URLSearchParams(location.search).get("then")?.match(/^\/[A-Za-z0-9_/]*$/)?.[0] ?? "/account";
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
  nameTitle($("account-name"), account.username);
  api("/friends").then(({ received }) => ($("friend-requests").textContent = received.length ? `${received.length} new` : ""), () => {});
  $("go-profile").href = `/u/${account.username}`;
  api("/account/unread").then(({ unread }) => ($("unread").textContent = unread ? String(unread) : ""), () => {});
  const mine = await api("/account/worlds");
  $("my-worlds").replaceChildren(...mine.map(worldRow));
  $("my-none").hidden = !!mine.length;
}

/** A builder's page: their worlds, and for a signed-in visitor, a message and a block. */
async function showProfile(name) {
  const p = await api(`/users/${name}`);
  document.title = `${p.username} · Sandbox`;
  nameTitle($("profile-name"), p.username);
  $("profile-about").textContent = `Joined ${new Date(p.joined).toLocaleDateString(undefined, { month: "long", year: "numeric" })} · ${counted(p.players, "player")} · ${counted(p.votes, "vote")}`;
  $("profile-worlds").replaceChildren(...p.worlds.map(worldRow));
  $("profile-none").hidden = p.worlds.length > 0;
  const signedIn = !!(await whoAmI());
  $("profile-message").hidden = p.me;
  $("profile-message").href = signedIn ? `/messages/${p.username}` : `/signin?then=/messages/${p.username}`;
  $("profile-block").hidden = p.me || !signedIn;
  $("profile-friend").hidden = p.me;
  const showFriend = () => {
    $("profile-friend").firstChild.textContent = { friends: "Friends", sent: "Request sent", received: "Accept friend request" }[p.friend] ?? "Add friend";
    $("profile-friend").lastChild.textContent = { friends: "Unfriend", sent: "Take back" }[p.friend] ?? "";
    $("profile-decline").hidden = p.friend !== "received";
  };
  showFriend();
  const setFriend = async (on) => {
    try {
      p.friend = (await api(`/friends/${p.username}`, { method: on ? "PUT" : "DELETE" })).friend;
    } catch (e) {
      return void ($("error").textContent = e.message);
    }
    showFriend();
  };
  $("profile-friend").onclick = async () => {
    if (!signedIn) return go(`/signin?then=/u/${p.username}`);
    setFriend(!p.friend || p.friend === "received");
  };
  $("profile-decline").onclick = () => setFriend(false);
  const showBlock = () => ($("profile-block").textContent = p.blocked ? "Unblock" : "Block");
  showBlock();
  $("profile-block").onclick = async () => {
    try {
      p.blocked = (await api(`/blocks/${p.username}`, { method: p.blocked ? "DELETE" : "PUT" })).blocked;
    } catch (e) {
      return void ($("error").textContent = e.message);
    }
    showBlock();
    if (p.blocked) (p.friend = null), showFriend();
  };
}

/** Messages: plain text, read only by the two people in a conversation. */
async function showMessages() {
  if (!(await whoAmI())) return go("/signin?then=/messages");
  const threads = await api("/messages");
  $("threads-none").hidden = threads.length > 0;
  $("threads").replaceChildren(
    ...threads.map((t) =>
      el("a", { className: "world", href: `/messages/${t.with}` }, el("span", { className: "what" }, el("b", { textContent: t.with }), el("small", { textContent: `${t.last.mine ? "You: " : ""}${t.last.body}` })), el("span", { className: "value", textContent: t.unread ? `${t.unread} new` : ago(t.last.at) })),
    ),
  );
}
async function showThread(name) {
  if (!(await whoAmI())) return go(`/signin?then=/messages/${name}`);
  nameTitle($("thread-name"), name);
  $("thread-profile").href = `/u/${name}`;
  $("message-list").replaceChildren();
  const t = await api(`/messages/${name}`);
  nameTitle($("thread-name"), t.with);
  $("thread-blocked").hidden = !t.blocked;
  const row = (m) => {
    const head = el("small", { textContent: `${m.mine ? "You" : t.with} · ${ago(m.at)}` });
    if (!m.mine)
      head.append(
        el("button", {
          className: "quiet",
          textContent: "Report",
          onclick: async (e) => {
            e.target.disabled = true;
            await api(`/messages/${m.id}/report`, { method: "POST" }).catch(() => {});
            e.target.textContent = "Reported";
          },
        }),
      );
    return el("div", { className: m.mine ? "comment mine" : "comment" }, head, el("p", { textContent: m.body }));
  };
  $("message-list").replaceChildren(...t.messages.map(row));
  $("message-form").onsubmit = async (e) => {
    e.preventDefault();
    const body = $("message-text").value.trim();
    if (!body) return;
    try {
      $("message-list").append(row(await api("/messages", { method: "POST", body: JSON.stringify({ to: t.with, body }) })));
    } catch (err) {
      return void ($("error").textContent = err.message);
    }
    $("message-text").value = "";
  };
  $("message-text").focus();
}

/** A username heading: one word, sized by its length so it fits on one line. */
function nameTitle(h1, name) {
  h1.textContent = name;
  h1.style.setProperty("--len", String(Math.max(8, name.length)));
}

/** Friends, and the requests waiting each way. */
async function showFriends() {
  if (!(await whoAmI())) return go("/signin?then=/friends");
  const f = await api("/friends");
  const row = (name, value) => el("a", { className: "item", href: `/u/${name}` }, name, el("span", { className: "value", textContent: value }));
  $("friend-list").replaceChildren(...f.received.map((n) => row(n, "Wants to be friends")), ...f.friends.map((n) => row(n, "")), ...f.sent.map((n) => row(n, "Request sent")));
  $("friends-none").hidden = f.received.length + f.friends.length + f.sent.length > 0;
}

const SCREENS = { "/": "home", "/join": "join", "/worlds": "worlds", "/host": "host", "/signin": "signin", "/signup": "signup", "/account": "account", "/account/delete": "delete", "/messages": "messages", "/friends": "friends", "/notifications": "notifications" };
const BACK = { world: "/worlds", signup: "/signin", delete: "/account", messages: "/account", friends: "/account", notifications: "/account", thread: "/messages" };
async function route() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const [, kind, id] = path.match(/^\/(w|m)\/([a-z0-9]{12})$/) ?? [];
  const user = path.match(/^\/u\/([A-Za-z0-9_]{3,20})$/)?.[1];
  const talking = path.match(/^\/messages\/([A-Za-z0-9_]{3,20})$/)?.[1];
  const screen = id ? "world" : user ? "profile" : talking ? "thread" : (SCREENS[path] ?? "home");
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== screen;
  stats.screen(screen);
  $("back").hidden = screen === "home";
  $("back").href = BACK[screen] ?? "/";
  $("go-signup").search = location.search;
  $("error").textContent = "";
  document.title = "Sandbox";
  try {
    if (screen === "worlds") await Promise.all([showWorlds(), showLive()]);
    if (screen === "world") await showWorld(id, kind === "m" ? "mod" : "world");
    if (screen === "account") await showAccount();
    if (screen === "profile") await showProfile(user);
    if (screen === "messages") await showMessages();
    if (screen === "friends") await showFriends();
    if (screen === "notifications") await showNotices();
    if (screen === "thread") await showThread(talking);
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
