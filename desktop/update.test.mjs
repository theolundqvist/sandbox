// A real Linux update between two AppImage builds on a stand-in GitHub: SANDBOX_APPIMAGES=<dir with 0.2.0/ and 0.2.1/> xvfb-run -a node --test update.test.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const BUILDS = process.env.SANDBOX_APPIMAGES;
const DESKTOP = import.meta.dirname;
const home = mkdtempSync(join(tmpdir(), "sandbox-update-"));
const app = join(home, ".local/share/sandbox");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = () => 20000 + Math.floor(Math.random() * 20000);

async function until(what, check, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const got = await check().catch(() => null);
    if (got) return got;
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const github = { latest: "0.2.1", served: "0.2.0" };
const GITHUB = port();
const server = createServer((req, res) => {
  if (req.url === "/latest") return res.end(JSON.stringify({ tag_name: `v${github.latest}` }));
  if (req.url === "/install") return res.end(readFileSync(join(DESKTOP, "install")));
  if (req.url === "/download/Sandbox-linux-x86_64.AppImage") return res.end(readFileSync(join(BUILDS, github.served, "Sandbox-linux-x86_64.AppImage")));
  res.statusCode = 404;
  res.end();
}).listen(GITHUB);

const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  ELECTRON_DISABLE_SANDBOX: "1",
  SANDBOX_RELAY: `http://127.0.0.1:${port()}`,
  SANDBOX_RELEASE: `http://127.0.0.1:${GITHUB}/download`,
  SANDBOX_UPDATES: `http://127.0.0.1:${GITHUB}/latest`,
  SANDBOX_INSTALLER: `http://127.0.0.1:${GITHUB}/install`,
};
const installed = () => readFileSync(join(app, "resources/app.asar")).toString("latin1").match(/"name":\s*"sandbox-desktop"[^}]*?"version":\s*"([\d.]+)"/)?.[1];
/** The app's processes, by the program they run. */
const running = () =>
  readdirSync("/proc").filter((pid) => {
    try {
      return /^\d+$/.test(pid) && readlinkSync(`/proc/${pid}/exe`) === `${app}/sandbox`;
    } catch {
      return false;
    }
  });
// The update replaces the app's folder, its log included.
const opened = () => readFileSync(join(app, "app.log"), "utf8").includes("Sandbox is open");

after(async () => {
  for (const pid of running()) process.kill(Number(pid));
  await sleep(2000);
  server.close();
  server.closeAllConnections();
  rmSync(home, { recursive: true, force: true });
});

test("the installed app finds the new release, installs it and opens again as the new version", { skip: !BUILDS && "set SANDBOX_APPIMAGES" }, async () => {
  const debug = port();
  const install = spawn("bash", [join(DESKTOP, "install"), `--remote-debugging-port=${debug}`], { env, stdio: "inherit" });
  assert.equal(await new Promise((r) => install.once("exit", r)), 0);
  assert.equal(installed(), "0.2.0");

  github.served = "0.2.1";
  const browser = await until("the app's debugger", () => chromium.connectOverCDP(`http://127.0.0.1:${debug}`));
  const shell = await until("the start screen", async () => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("sandbox://app/shell.html")));
  await until("Update 0.2.1", async () => (await shell.textContent("#go-update")) === "Update0.2.1" && (await shell.isVisible("#go-update")));
  await shell.click("#go-update");

  await until("the new version", async () => installed() === "0.2.1" && opened() && running().length, 120000);
  assert.ok(existsSync(join(home, ".local/bin/sandbox")));
});
