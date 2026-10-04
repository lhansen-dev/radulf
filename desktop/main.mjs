// `make desktop`: Radulf in a window of its own. A shell around a server that
// is already running (`make dev`, `make start`, or an install elsewhere): it
// loads the server's own origin, so the session cookie, the proxy's Origin
// check and the CSP apply exactly as they do in a browser tab, and nothing
// under src/ knows it is here. Electron's defaults — a sandboxed renderer,
// context isolation, no Node in the page — stay as they are.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { app, BrowserWindow, net, screen, shell } from "electron";
import { routeUrl } from "./links.mjs";

const RETRY_MS = 2000;
const PROBE_TIMEOUT_MS = 5000;
const DEFAULT_BOUNDS = { width: 1280, height: 800 };
// net::ERR_ABORTED: a navigation replaced by another, or one that became a
// download. Neither says anything about the server.
const ERR_ABORTED = -3;

const appUrl = serverUrl(process.env.RADULF_URL || "http://127.0.0.1:3000");
const stateFile = path.join(app.getPath("userData"), "window-state.json");
let waiting = false;

if (!app.requestSingleInstanceLock()) {
  // A second window would double every notification and alert sound.
  console.log("[radulf desktop] already open — switching to that window");
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    // The terminal that just ran `make desktop` is the active app, and on
    // macOS win.focus() alone leaves it in front.
    app.focus({ steal: true });
    win.focus();
  });
  // Started from a terminal, so closing the window ends the process and hands
  // the prompt back — on macOS too, where apps usually linger in the Dock.
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(createWindow);
}

function serverUrl(raw) {
  let url = null;
  try {
    url = new URL(raw);
  } catch {
    // reported below
  }
  if (url?.protocol !== "http:" && url?.protocol !== "https:") {
    console.error(`[radulf desktop] URL must be an http(s) address, got "${raw}"`);
    process.exit(1);
  }
  return url;
}

function createWindow() {
  const { bounds, maximized } = savedState();
  const win = new BrowserWindow({
    ...bounds,
    title: "Radulf",
    // The default theme's --background (src/app/globals.css), so the window
    // does not flash white before the first paint.
    backgroundColor: "#0b0d10",
  });
  if (maximized) win.maximize();
  win.on("close", () => {
    fs.writeFileSync(stateFile, JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }));
  });

  const { webContents } = win;
  // target="_blank" and window.open never get a second Electron window.
  webContents.setWindowOpenHandler(({ url }) => {
    if (routeUrl(url, appUrl.origin) !== "deny") void shell.openExternal(url);
    return { action: "deny" };
  });
  // A plain link off the server's origin would otherwise replace the app.
  webContents.on("will-navigate", (details) => {
    const route = routeUrl(details.url, appUrl.origin);
    if (route === "app") return;
    details.preventDefault();
    if (route === "browser") void shell.openExternal(details.url);
  });
  // Not started yet, restarting, or unreachable: wait for it rather than
  // leaving a blank window.
  webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== ERR_ABORTED) void waitForServer(win, url, description);
  });
  // The same, behind a reverse proxy, which answers for a stopped server.
  webContents.on("did-navigate", (_event, url, status) => {
    if (status >= 502 && status <= 504) void waitForServer(win, url, `HTTP ${status}`);
  });

  load(win, appUrl.href);
}

// Last session's size and position, unless the display it was on is gone.
function savedState() {
  try {
    const { bounds, maximized } = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
      bounds.x < a.x + a.width && a.x < bounds.x + bounds.width &&
      bounds.y < a.y + a.height && a.y < bounds.y + bounds.height);
    if (onScreen) return { bounds, maximized };
  } catch {
    // first run, or an unreadable file
  }
  return { bounds: DEFAULT_BOUNDS, maximized: false };
}

// Holds a waiting page until the server's liveness route answers, then
// retries the page that failed. One loop at a time: a failed retry comes back
// through did-fail-load and starts the next.
async function waitForServer(win, failedUrl, reason) {
  if (waiting) return;
  waiting = true;
  const retryUrl = routeUrl(failedUrl, appUrl.origin) === "app" ? failedUrl : appUrl.href;
  await win.loadURL(waitingPage(reason)).catch(() => {});
  while (!win.isDestroyed() && !(await serverUp())) await sleep(RETRY_MS);
  waiting = false;
  if (!win.isDestroyed()) load(win, retryUrl);
}

async function serverUp() {
  try {
    const res = await net.fetch(new URL("/api/health", appUrl).href, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function load(win, url) {
  // A failed load also fires did-fail-load, which handles it.
  win.loadURL(url).catch(() => {});
}

function waitingPage(reason) {
  const html = `<!doctype html><meta charset="utf-8"><title>Radulf</title>
<body style="margin:0;height:100vh;display:grid;place-content:center;gap:6px;text-align:center;
  background:#0b0d10;color:#d7dce2;font:14px/1.5 system-ui,sans-serif">
<p style="margin:0;font-size:16px">Waiting for Radulf at ${escapeHtml(appUrl.href)}</p>
<p style="margin:0;opacity:.6">${escapeHtml(reason)} · retrying every ${RETRY_MS / 1000}s ·
  start the server with <code>make dev</code> or <code>make start</code></p>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(text) {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}
