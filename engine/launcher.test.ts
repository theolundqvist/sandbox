// A throwaway launcher and relay over real HTTP: only someone at the launcher's own machine gets the host key.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const dir = mkdtempSync(join(tmpdir(), "sandbox-launcher-"));
const LAUNCHER = 17000 + Math.floor(Math.random() * 1000);
const RELAY = LAUNCHER + 1000;
const procs: Subprocess[] = [];

async function up(url: string) {
  for (let i = 0; i < 100; i++) {
    if (await fetch(url).then(() => true, () => false)) return;
    await Bun.sleep(100);
  }
  throw new Error(`${url} never came up`);
}

beforeAll(async () => {
  procs.push(Bun.spawn(["bun", join(import.meta.dir, "../relay/relay.ts")], { env: { ...process.env, PORT: String(RELAY), RELAY_CLAIMS: join(dir, "claims.json") }, stdout: "ignore" }));
  procs.push(
    Bun.spawn(["bun", join(import.meta.dir, "launcher.ts")], {
      env: { ...process.env, PORT: String(LAUNCHER), SANDBOX_DATA: join(dir, "data"), SANDBOX_RELAY: `http://127.0.0.1:${RELAY}`, SANDBOX_NO_OPEN: "1" },
      stdout: "ignore",
    }),
  );
  await Promise.all([up(`http://127.0.0.1:${RELAY}/`), up(`http://127.0.0.1:${LAUNCHER}/menu`)]);
});

afterAll(() => {
  for (const p of procs) p.kill();
  rmSync(dir, { recursive: true, force: true });
});

const localKey = (base: string, headers: Record<string, string> = {}) => fetch(`${base}/api/local-key`, { headers });

test("loopback gets the host key, and the key opens the main menu", async () => {
  for (const host of ["127.0.0.1", "localhost"]) {
    const res = await localKey(`http://${host}:${LAUNCHER}`);
    expect(res.status).toBe(200);
    const { key } = await res.json();
    const menu = await fetch(`http://${host}:${LAUNCHER}/api/menu/state`, { headers: { authorization: `Bearer ${key}` } });
    expect(menu.status).toBe(200);
  }
});

test("loopback through a proxy, or under a foreign host name, is not the host", async () => {
  for (const headers of <Record<string, string>[]>[{ "cf-connecting-ip": "203.0.113.9" }, { "x-forwarded-for": "203.0.113.9" }, { forwarded: "for=203.0.113.9" }, { "x-sandbox-relayed": "1" }, { host: "evil.example" }])
    expect((await localKey(`http://127.0.0.1:${LAUNCHER}`, headers)).status).toBe(401);
});

test("a LAN address is not the host", async () => {
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  expect(lan).toBeTruthy();
  expect((await localKey(`http://${lan}:${LAUNCHER}`)).status).toBe(401);
});

test("a player through the relay is not the host", async () => {
  const { key } = await (await localKey(`http://127.0.0.1:${LAUNCHER}`)).json();
  const menu = async (action: string, body?: object) =>
    (await fetch(`http://127.0.0.1:${LAUNCHER}/api/menu/${action}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}` }, body: body && JSON.stringify(body) })).json();
  await menu("share", { on: true });
  let url: string | null = null;
  for (let i = 0; i < 50 && !url; i++, await Bun.sleep(100)) url = (await menu("state")).tunnel?.url ?? null;
  expect(url).toStartWith(`http://127.0.0.1:${RELAY}/r/`);
  // The relay is reached on loopback here, exactly like a relay on the host's machine would be.
  expect((await fetch(`${url}/menu`)).status).toBe(200);
  expect((await localKey(url!)).status).toBe(401);
  expect((await localKey(url!, { host: "localhost" })).status).toBe(401);
});

test("a join code leads to the game's invite link until the host replaces it or stops sharing", async () => {
  const { key } = await (await localKey(`http://127.0.0.1:${LAUNCHER}`)).json();
  const menu = async (action: string, body?: object) =>
    (await fetch(`http://127.0.0.1:${LAUNCHER}/api/menu/${action}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${key}` }, body: body && JSON.stringify(body) })).json();
  const lookup = (code: string, ip = "198.51.100.1") => fetch(`http://127.0.0.1:${RELAY}/join/${code}`, { headers: { "x-real-ip": ip } });
  await menu("share", { on: true });
  const s = await menu("create", { name: "Code Test" });
  expect(s.tunnel.code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
  const first = s.tunnel.code;
  const formatted = `${first.slice(0, 3)}-${first.slice(3).toLowerCase()}`;
  expect(await (await lookup(formatted)).json()).toEqual({ url: `${s.tunnel.url}/#invite=${s.running.invite}` });

  const invited = await menu("invite", {});
  expect(invited.running.invite).not.toBe(s.running.invite);
  expect((await (await lookup(first)).json()).url).toEndWith(`#invite=${invited.running.invite}`);

  const renewed = await menu("code", {});
  expect(renewed.tunnel.code).not.toBe(first);
  expect(await (await lookup(first)).json()).toEqual({ error: "No game with that code" });
  expect((await lookup(renewed.tunnel.code)).status).toBe(200);

  await menu("share", { on: false });
  await Bun.sleep(200);
  expect((await lookup(renewed.tunnel.code)).status).toBe(404);
  await menu("stop", {});
});

test("join code lookups are limited per address", async () => {
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await fetch(`http://127.0.0.1:${RELAY}/join/AAAAAA`, { headers: { "x-real-ip": "198.51.100.2" } })).status);
  expect(statuses).toEqual([...Array(10).fill(404), 429]);
  expect((await fetch(`http://127.0.0.1:${RELAY}/join/AAAAAA`, { headers: { "x-real-ip": "198.51.100.3" } })).status).toBe(404);
});

test("worlds made without a name each get their own", async () => {
  const { key } = await (await localKey(`http://127.0.0.1:${LAUNCHER}`)).json();
  const create = async () => (await fetch(`http://127.0.0.1:${LAUNCHER}/api/menu/create`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: "{}" })).json();
  await create();
  const { worlds } = await create();
  const unnamed = worlds.filter((w: { name: string }) => w.name !== "Code Test").map((w: { name: string }) => w.name);
  expect(unnamed).toHaveLength(2);
  expect(new Set(unnamed).size).toBe(2);
  expect(unnamed).not.toContain("Sandbox");
});

test("a computer without git hosts worlds, reloads mods, and says history needs Git", async () => {
  // Only bun on the PATH: any git call would fail to spawn and stop the world.
  const bin = join(dir, "nogit-bin");
  mkdirSync(bin);
  symlinkSync(Bun.which("bun")!, join(bin, "bun"));
  const port = LAUNCHER + 500;
  procs.push(Bun.spawn([join(bin, "bun"), join(import.meta.dir, "launcher.ts")], { env: { PATH: bin, HOME: dir, PORT: String(port), SANDBOX_DATA: join(dir, "nogit"), SANDBOX_NO_OPEN: "1" }, stdout: "ignore", stderr: "ignore" }));
  await up(`http://127.0.0.1:${port}/menu`);
  const { key } = await (await localKey(`http://127.0.0.1:${port}`)).json();
  const s = await (await fetch(`http://127.0.0.1:${port}/api/menu/create`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ name: "No Git", start: "basics" }) })).json();
  expect(s.running?.name).toBe("No Git");
  const player = await (await fetch(`http://127.0.0.1:${port}/api/join`, { method: "POST", body: JSON.stringify({ invite: s.running.invite, name: "builder" }) })).json();
  const tool = (name: string, args: Record<string, string>) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(args)) form.append(k, v);
    return fetch(`http://127.0.0.1:${port}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${player.key}` }, body: form });
  };
  const reload = await tool("reload", { mod: "basics" });
  expect(reload.status).toBe(200);
  const history = await tool("history", { mod: "basics" });
  expect(history.status).toBe(422);
  expect(await history.text()).toStartWith("Needs Git");
}, 60_000);
