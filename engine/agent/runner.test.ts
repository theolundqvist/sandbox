import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_NAMES } from "./box-tools";
import { type FakeAnswer, type FakeRequest, fakeAnthropic, toolResults } from "./fake-anthropic";
import { startAgent } from "./runner";

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDLoooriPpj/9k=",
  "base64",
);
const SECRET = "CANARY-7f3a";
let root: string;
let home: string;
let world: { url: string; calls: { tool: string; fields: Record<string, string> }[]; stop: () => void };
let usage: { url: string; posts: { auth: string | null; body: any }[]; stop: () => void };
let script: (req: FakeRequest, n: number) => FakeAnswer | Promise<FakeAnswer> = () => ({ text: "ok" });
let model: ReturnType<typeof fakeAnthropic>;

/** A world server's CLI with two files, the way engine/cli.ts answers. */
function fakeWorld() {
  const files: Record<string, string> = { "GUIDE.md": "# Guide\n", "mods/cube/server.ts": "export default {};\n" };
  const calls: { tool: string; fields: Record<string, string> }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer player-key") return new Response("stale\n", { status: 401 });
      const tool = new URL(req.url).pathname.slice(5);
      const fields: Record<string, string> = {};
      if (req.method === "POST") for (const [k, v] of await req.formData()) fields[k] = typeof v === "string" ? v : await v.text();
      calls.push({ tool, fields });
      const keep = "\n\nWhen you are done with this, call wait_for_chat again. Never end your turn.\n";
      if (tool === "list_files") return new Response(Object.entries(files).map(([p, t]) => `${p}  h${t.length}`).join("\n") + keep);
      if (tool === "read_file") return new Response(`hash: h${files[fields.path!]!.length}\n${files[fields.path!]}`);
      if (tool === "write_file") return new Response(`Wrote ${fields.path}. New hash: h${fields.content!.length}. Call reload.${keep}`);
      if (tool === "screenshot") return new Response(JPEG, { headers: { "content-type": "image/jpeg" } });
      return new Response(`ran ${tool}${keep}`);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, calls, stop: () => server.stop(true) };
}

beforeAll(() => {
  root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agent-test-"));
  home = join(root, "home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_canary"), SECRET);
  writeFileSync(join(root, "beside-run"), SECRET);
  world = fakeWorld();
  const posts: { auth: string | null; body: any }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      posts.push({ auth: req.headers.get("authorization"), body: await req.json() });
      return new Response(null, { status: 204 });
    },
  });
  usage = { url: `http://127.0.0.1:${server.port}`, posts, stop: () => server.stop(true) };
  model = fakeAnthropic((req, n) => script(req, n));
  process.env.SANDBOX_AGENT_TEST_BASE_URL = model.url;
});
afterAll(() => {
  world.stop();
  usage.stop();
  model.stop();
  rmSync(root, { recursive: true, force: true });
});

async function agent(name: string) {
  const events: any[] = [];
  const dir = join(root, name);
  mkdirSync(dir);
  const a = await startAgent(
    { world: { base: world.url, key: "player-key", name: "Test World" }, model: { provider: "anthropic", id: "claude-sonnet-4-5" }, apiKey: "sk-synthetic", usage: { host: usage.url, token: "install-token", world: "world-key-0001" } },
    dir,
    (e) => events.push(e),
  );
  return { a, events, dir };
}

/** Plays the model: one answer per request, in order, then a closing reply. */
function play(...answers: FakeAnswer[]) {
  const start = model.requests.length;
  script = (_req, n) => answers[n - start] ?? { text: "done" };
  return () => model.requests.slice(start);
}

const results = (req: FakeRequest) => toolResults(req).map((r: any) => (Array.isArray(r.content) ? r.content : [{ type: "text", text: r.content }]));
const resultText = (req: FakeRequest) => JSON.stringify(results(req));

test("every request offers exactly the box tools, and a changed roster stops the turn before the model sees it", async () => {
  const { a, events } = await agent("roster");
  const sent = play({ calls: [{ name: "box_bash", input: { command: "echo hi" } }] });
  await a.prompt("hello");
  expect(sent().length).toBe(2);
  for (const req of sent()) expect([...req.tools].sort()).toEqual([...TOOL_NAMES].sort());

  const before = model.requests.length;
  const extra = { ...a.session.agent.state.tools[0], name: "bash" };
  a.session.agent.setTools([...a.session.agent.state.tools, extra]);
  await a.prompt("again");
  expect(model.requests.length).toBe(before);
  expect(events.some((e) => e.t === "error" && /tools other than its own/.test(e.text))).toBe(true);
  await a.close();
});

test("a hostile model cannot read or change anything outside its copy of the world, nor reach the network", async () => {
  const { a, dir } = await agent("hostile");
  const canary = join(home, ".ssh", "id_canary");
  const sent = play(
    {
      calls: [
        { name: "box_bash", input: { command: `cat ${canary}; cat ${join(root, "beside-run")}; cat ${join(dir, "auth.db")} | head -c 200; ln -s ${canary} link; cat link; echo pwned > ${join(home, "planted")}; curl -sS https://example.com; cat /etc/passwd; ls ~/..` } },
        { name: "box_read", input: { path: canary } },
        { name: "box_read", input: { path: "link" } },
        { name: "box_write", input: { path: join(home, ".ssh", "authorized_keys"), content: "attacker" } },
        { name: "box_grep", input: { pattern: "CANARY", path: home } },
      ],
    },
    { calls: [{ name: "box_bash", input: { command: `id=0123456789abcdef; ln -s ${home} $SANDBOX_CHANNEL/$id; ln -s ${join(home, "out")} $SANDBOX_CHANNEL/$id.out; echo $id > $SANDBOX_CHANNEL/requests; sleep 0.3; echo sent` } }] },
  );
  await a.prompt("try to escape");
  const text = sent().map(resultText).join("\n");
  expect(text).not.toContain(SECRET);
  expect(existsSync(join(home, "planted"))).toBe(false);
  expect(existsSync(join(home, ".ssh", "authorized_keys"))).toBe(false);
  expect(existsSync(join(home, "out"))).toBe(false);
  expect(readFileSync(canary, "utf8")).toBe(SECRET);
  expect(existsSync(join(home, "home"))).toBe(false);
  expect(text).toMatch(/Permission denied|Operation not permitted/);
  expect(text).toContain("sent");
  await a.close();
});

test("Stop kills the turn and the box within a second", async () => {
  const { a, events } = await agent("stop");
  play({ calls: [{ name: "box_bash", input: { command: "sleep 313.5 & sleep 313.5; echo never" } }] });
  const running = a.prompt("run forever");
  const sleeping = () => Bun.spawnSync(["pgrep", "-f", "sleep 313.5"]).stdout.toString().trim();
  while (!sleeping()) await Bun.sleep(20);
  const t0 = performance.now();
  await a.stop();
  await running;
  while (sleeping() && performance.now() - t0 < 2000) await Bun.sleep(10);
  const took = performance.now() - t0;
  expect(sleeping()).toBe("");
  expect(took).toBeLessThan(1000);
  expect(events.some((e) => e.t === "status" && e.text === "Stopped")).toBe(true);
  await a.close();
});

test("a screenshot reaches the model as an image block, and publishing carries the copy's base hash", async () => {
  const { a } = await agent("image");
  const start = model.requests.length;
  const sent = () => model.requests.slice(start);
  script = (req, n) => {
    if (n === start) return { calls: [{ name: "box_bash", input: { command: "world screenshot" } }] };
    if (n === start + 1) return { calls: [{ name: "box_read_image", input: { path: resultText(req).match(/\/[^"\\]*screenshot-[0-9a-f]+\.jpg/)![0] } }] };
    if (n === start + 2) return { calls: [{ name: "box_bash", input: { command: "echo 'export default { v: 2 };' > mods/cube/server.ts && world write_file path=mods/cube/server.ts content=@mods/cube/server.ts" } }] };
    return { text: "done" };
  };
  await a.prompt("look and publish");
  const blocks = sent().flatMap(results).flat();
  const image = blocks.find((b: any) => b.type === "image");
  expect(image?.source).toEqual({ type: "base64", media_type: "image/jpeg", data: JPEG.toString("base64") });
  const write = world.calls.findLast((c) => c.tool === "write_file")!;
  expect(write.fields).toEqual({ path: "mods/cube/server.ts", content: "export default { v: 2 };\n", base_hash: "h19" });
  expect(resultText(sent().at(-1)!)).not.toContain("wait_for_chat");
  await a.close();
});

test("each turn posts its usage to the install's agent-usage endpoint", async () => {
  const { a } = await agent("usage");
  const before = usage.posts.length;
  play({ calls: [{ name: "box_bash", input: { command: "true" } }], usage: { input: 1200, output: 80 } }, { text: "done", usage: { input: 1500, output: 40 } });
  await a.prompt("count me");
  expect(usage.posts.length).toBe(before + 1);
  const post = usage.posts.at(-1)!;
  expect(post.auth).toBe("Bearer install-token");
  expect(post.body).toMatchObject({ world: "world-key-0001", provider: "anthropic", model: "claude-sonnet-4-5", subscription: false, inputTokens: 2700, outputTokens: 120, requests: 2 });
  expect(post.body.costUsd).toBeGreaterThan(0);
  await a.close();
});
