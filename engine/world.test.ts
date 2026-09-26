// A throwaway world over real HTTP and websockets, driven through the same tools a Claude uses.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const dir = mkdtempSync(join(tmpdir(), "sandbox-world-"));
const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let world: Subprocess;
let key: string;
let player: WebSocket;
const received: any[] = [];

beforeAll(async () => {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ name: "Test", rules: "open", start: "basics", invite: "test-invite", hostKey: "test-host" }));
  world = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], { env: { ...process.env, SANDBOX_DATA: dir, PORT: String(PORT) }, stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 200 && !(await fetch(`${BASE}/api/info`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
  ({ key } = await (await fetch(`${BASE}/api/join`, { method: "POST", body: JSON.stringify({ invite: "test-invite", name: "builder" }) })).json());
  player = new WebSocket(`ws://127.0.0.1:${PORT}/ws?key=${key}`);
  player.onmessage = ({ data }) => received.push(JSON.parse(String(data)));
  await new Promise((resolve) => (player.onopen = resolve));
}, 30_000);

afterAll(() => {
  player?.close();
  world?.kill();
  rmSync(dir, { recursive: true, force: true });
});

async function tool(name: string, args: Record<string, unknown> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(args)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  const res = await fetch(`${BASE}/cli/${name}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
  return { status: res.status, text: await res.text() };
}

const write = (path: string, content: string) => tool("write_file", { path, content });

test("a mod goes live at most once every 20 s, says when it may again, and a reload that leaves its client unchanged doesn't swap it in players' games", async () => {
  expect((await tool("reload", { mod: "basics" })).status).toBe(200);
  const refused = await tool("reload", { mod: "basics" });
  expect(refused.status).toBe(422);
  const wait = Number(refused.text.match(/Reload again in (\d+) s/)?.[1]);
  expect(wait).toBeGreaterThan(15);
  expect(wait).toBeLessThanOrEqual(20);
  await Bun.sleep(wait * 1000);
  expect((await tool("reload", { mod: "basics" })).status).toBe(200);
  expect(received.filter((m) => m.t === "mod" && m.name === "basics")).toEqual([]);

  await write("mods/painted/client.ts", `export default { init() {} };`);
  expect((await tool("reload", { mod: "painted" })).status).toBe(200);
  expect(received.filter((m) => m.t === "mod" && m.name === "painted")).toHaveLength(1);
}, 60_000);

test("reloads of a mod that pile up behind another reload go live once, and every caller hears the result", async () => {
  await write("mods/slow/server.ts", `export default { tick() {} };`);
  await write("mods/twin/server.ts", `export default { tick() {} };`);
  const slow = tool("reload", { mod: "slow" });
  const twins = await Promise.all([tool("reload", { mod: "twin" }), tool("reload", { mod: "twin" })]);
  expect((await slow).status).toBe(200);
  for (const twin of twins) {
    expect(twin.status).toBe(200);
    expect(twin.text).toStartWith("twin v1 is live");
  }
}, 30_000);

test("Claudes' messages to each other arrive whole, and a chat line too long for players is refused instead of cut", async () => {
  const { key: other } = await (await fetch(`${BASE}/api/join`, { method: "POST", body: JSON.stringify({ invite: "test-invite", name: "other" }) })).json();
  const contract = `Contract: ${"x".repeat(1500)} END`;
  expect((await tool("say", { text: contract, to: "claudes" })).status).toBe(200);
  const heard = await (await fetch(`${BASE}/cli/status`, { method: "POST", headers: { authorization: `Bearer ${other}` } })).text();
  expect(heard).toContain(`[claudes] builder's Claude: ${contract}`);

  const refused = await tool("say", { text: "y".repeat(401) });
  expect(refused.status).toBe(422);
  expect(refused.text).toStartWith("That is 401 characters");
  expect(received.some((m) => m.t === "chat" && m.text.startsWith("yyy"))).toBe(false);
  expect((await tool("say", { text: "z".repeat(400) })).status).toBe(200);
  await Bun.sleep(100);
  expect(received.find((m) => m.t === "chat" && m.text.startsWith("zzz"))?.text).toHaveLength(400);

  const banner = await tool("reload", { mod: "basics", announce: { title: "Long", text: "w".repeat(161) } });
  expect(banner.status).toBe(422);
  expect(banner.text).toStartWith("announce.text is 161 characters");
});
