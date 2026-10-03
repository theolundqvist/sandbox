// Usage stats from the start screen and the app itself, sent to Community under this computer's install: the one its game server signs up for free voice, in the same secrets file. The start screen shows before any game server has run, so on a first launch this signs up instead.
const { chmodSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const COMMUNITY = process.env.SANDBOX_COMMUNITY ?? "https://sandbox.api.lundqvistliss.com";

/** Batches of 50 at most, one every 10 s at most, and what's left when the app quits; offline, they're dropped. Off when the player turned off Share usage stats, a choice the game server's menu page honours too. */
module.exports = function usage(data, version) {
  const SECRETS = join(data, "secrets.json");
  const SHARE = join(data, "usage.json");
  const read = (path) => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return {};
    }
  };
  const sharing = () => read(SHARE).share !== false;
  const session = crypto.randomUUID();

  let signingUp = null;
  function install() {
    const { install } = read(SECRETS);
    if (install) return Promise.resolve(install);
    signingUp ??= fetch(`${COMMUNITY}/installs`, { method: "POST", signal: AbortSignal.timeout(10_000) })
      .then(async (res) => {
        if (!res.ok) return null;
        const { token } = await res.json();
        // The game server may have signed up meanwhile; one install per computer.
        const now = read(SECRETS);
        if (now.install) return now.install;
        mkdirSync(data, { recursive: true });
        writeFileSync(SECRETS, JSON.stringify({ ...now, install: { token, host: COMMUNITY } }, null, 2), { mode: 0o600 });
        chmodSync(SECRETS, 0o600);
        return { token, host: COMMUNITY };
      })
      .catch(() => null)
      .finally(() => (signingUp = null));
    return signingUp;
  }

  const post = async (events) => {
    const to = await install();
    if (!to) return;
    await fetch(`${to.host}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${to.token}`, "content-type": "application/json" },
      body: JSON.stringify({ events, app: { version, os: process.platform } }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  };

  let queue = [];
  let timer = null;
  let sent = 0;
  function flush() {
    clearTimeout(timer);
    timer = null;
    sent = Date.now();
    const batch = queue.splice(0, 50);
    if (queue.length) later();
    return batch.length ? post(batch) : Promise.resolve();
  }
  const later = () => (timer ??= setTimeout(flush, Math.max(0, sent + 10_000 - Date.now())));

  return {
    sharing,
    share(on) {
      mkdirSync(data, { recursive: true });
      writeFileSync(SHARE, JSON.stringify({ share: on }));
      if (!on) queue = [];
    },
    /** Events from the start screen, as front.js `usage` makes them. */
    add(events) {
      if (!sharing() || !Array.isArray(events)) return;
      queue.push(...events.slice(0, 50));
      later();
    },
    /** A step only the app sees, like an agent starting. */
    step(screen, action, props) {
      this.add([{ session, surface: "app", screen, action, props }]);
    },
    /** Sends everything left, for quitting. */
    async drain() {
      const batches = [];
      while (queue.length) batches.push(flush());
      clearTimeout(timer);
      timer = null;
      await Promise.allSettled(batches);
    },
  };
};
