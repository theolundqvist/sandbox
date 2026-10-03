// The hidden game a playtest's agent plays: one offscreen page that never shows, takes focus or reads the real mouse and keyboard. The world that started it talks to it in JSON lines on stdin and stdout.
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");

const url = new URL(process.env.SANDBOX_PLAYTEST);
app.setPath("userData", process.env.SANDBOX_PLAYTEST_DATA);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
app.commandLine.appendSwitch("use-angle", "swiftshader");
if (process.platform === "darwin") app.setActivationPolicy("prohibited");
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => app.exit(0));

const [W, H] = [960, 540];
/** sendInputEvent wants Chromium's key names; the agent writes the ones it knows. */
const KEYS = { space: "Space", enter: "Enter", return: "Enter", shift: "Shift", ctrl: "Control", control: "Control", alt: "Alt", tab: "Tab", escape: "Escape", esc: "Escape", up: "Up", down: "Down", left: "Left", right: "Right", arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right", backspace: "Backspace" };
const keyCode = (k) => KEYS[k.toLowerCase()] ?? (/^key[a-z]$/i.test(k) ? k.slice(3) : /^digit\d$/i.test(k) ? k.slice(5) : k.length === 1 ? k.toUpperCase() : k);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: W,
    height: H,
    focusable: false,
    skipTaskbar: true,
    webPreferences: { offscreen: true, preload: join(__dirname, "playtest-preload.cjs"), contextIsolation: false, sandbox: true, backgroundThrottling: false },
  });
  const wc = win.webContents;
  wc.setFrameRate(15);
  wc.setAudioMuted(true);
  wc.setUserAgent(`${wc.getUserAgent()} SandboxDesktop`);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (event, to) => new URL(to).origin === url.origin || event.preventDefault());
  void wc.loadURL(url.href);

  const send = (type, extra = {}) => wc.sendInputEvent({ type, x: W / 2, y: H / 2, ...extra });
  async function input({ keys = [], ms = 0, look, click }) {
    const codes = keys.map(keyCode);
    for (const keyCode of codes) send("keyDown", { keyCode });
    if (look) {
      // Each step moves the mouse off the centre and back; the page's emulated pointer lock drops the moves back, as a real lock recentres.
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(look[0]), Math.abs(look[1])) / 200));
      for (let i = 0; i < steps; i++) {
        const [dx, dy] = [Math.round(look[0] / steps), Math.round(look[1] / steps)];
        // Waiting for a frame after each move keeps Chromium from merging the pair into no move at all.
        send("mouseMove", { x: W / 2 + dx, y: H / 2 + dy, movementX: dx, movementY: dy });
        await drawn();
        send("mouseMove", { movementX: -dx, movementY: -dy });
        await drawn();
      }
    }
    if (click) {
      send("mouseDown", { button: click, clickCount: 1 });
      send("mouseUp", { button: click, clickCount: 1 });
    }
    await sleep(ms);
    for (const keyCode of codes.reverse()) send("keyUp", { keyCode });
    await drawn();
    return { ok: true };
  }
  /** Resolves once the page has handled the input sent so far and drawn a frame after it. */
  const drawn = () => wc.executeJavaScript("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  /** The next frame the page draws, HUD and all. */
  async function shot() {
    await drawn();
    return new Promise((resolve) => {
      const done = (image) => resolve({ data: image.toJPEG(80).toString("base64") });
      const timer = setTimeout(() => wc.capturePage().then(done), 5000);
      wc.once("paint", (_e, _dirty, image) => (clearTimeout(timer), done(image)));
      wc.invalidate();
    });
  }

  let buffered = "";
  process.stdin.on("data", (chunk) => {
    const lines = (buffered + chunk).split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      const msg = JSON.parse(line);
      (msg.t === "shot" ? shot() : input(msg)).then(
        (reply) => process.stdout.write(`${JSON.stringify({ id: msg.id, ...reply })}\n`),
        (e) => process.stdout.write(`${JSON.stringify({ id: msg.id, error: String(e?.message ?? e) })}\n`),
      );
    }
  });
});
