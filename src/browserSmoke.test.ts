// A real browser against the production build: the paths no unit test can
// see, because they live in how a browser behaves. The one that prompted it:
// under `Referrer-Policy: no-referrer` a browser sends `Origin: null` on a
// native form POST, the proxy's CSRF check refused it, and with auth on
// nobody could sign in — while every route test, which sets headers itself,
// stayed green.
//
// Needs the production build and a Chrome, so it runs only from
// `make check-browser` (RADULF_BROWSER_CHECK=1). Without a Chrome it skips
// locally and fails in CI, whose runner image ships one.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const PASSWORD = "correct horse battery staple";

function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ...["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map((bin) => {
      try {
        return execFileSync("which", [bin], { encoding: "utf8" }).trim();
      } catch {
        return undefined;
      }
    }),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

const enabled = process.env.RADULF_BROWSER_CHECK === "1";
const chrome = enabled ? findChrome() : null;
if (enabled && !chrome) {
  if (process.env.CI) throw new Error("make check-browser needs Chrome; set CHROME_PATH");
  console.warn("[browser check] no Chrome found (set CHROME_PATH): skipping");
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe.runIf(enabled && chrome)("browser smoke (auth on, production build)", () => {
  let root: string;
  let server: ChildProcess;
  let browser: Browser;
  let page: Page;
  let base: string;
  let log = "";

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "radulf-browser-"));
    const repo = path.join(root, "repos-root", "demo");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "# demo\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: repo });

    const port = await freePort();
    // `localhost`, not 127.0.0.1: the browser's Origin and the Host it sends
    // must name the same host for the proxy's same-origin check.
    base = `http://localhost:${port}`;
    server = spawn("node_modules/.bin/next", ["start", "-H", "127.0.0.1", "-p", String(port)], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        RADULF_DATA_DIR: path.join(root, "data"),
        RADULF_AUTH_PASSWORD_HASH: bcrypt.hashSync(PASSWORD, 4),
        RADULF_ROLES: "web",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (d) => (log += d));
    server.stderr?.on("data", (d) => (log += d));
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        // not listening yet
      }
      if (i > 100) throw new Error(`server did not start:\n${log}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    browser = await puppeteer.launch({ executablePath: chrome!, args: ["--no-sandbox"] });
    page = await browser.newPage();
    // The header's New task button only shows from the lg breakpoint up.
    await page.setViewport({ width: 1280, height: 900 });
    process.env.BROWSER_SMOKE_REPO = repo;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.kill("SIGKILL");
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** Click the visible, enabled button whose text is exactly `label`. */
  async function click(label: string, scope = "") {
    const handle = await page.waitForFunction(
      (text, within) =>
        [...document.querySelectorAll(`${within} button`)].find(
          (b) => b.textContent?.trim() === text && !(b as HTMLButtonElement).disabled && (b as HTMLElement).offsetParent,
        ),
      { timeout: 15_000 },
      label,
      scope,
    );
    await (handle.asElement() as unknown as { click(): Promise<void> }).click();
  }

  it("signs in through the login form", async () => {
    await page.goto(`${base}/login`);
    await page.type("input[type=password]", PASSWORD);
    await Promise.all([page.waitForNavigation(), page.keyboard.press("Enter")]);
    expect(new URL(page.url()).pathname).toBe("/");
    await page.waitForFunction(() => document.body.innerText.includes("Work"));
  }, 30_000);

  it("drives the API from the signed-in page, and creates a task through the dialog", async () => {
    const repo = process.env.BROWSER_SMOKE_REPO!;
    const status = await page.evaluate(async (repoPath) => {
      const send = (url: string, method: string, body: unknown) =>
        fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const settings = await send("/api/settings", "PATCH", { folderBrowserRoot: repoPath.replace(/\/demo$/, "") });
      const repos = await send("/api/repos", "POST", { name: "demo", path: repoPath });
      return [settings.status, repos.status];
    }, repo);
    expect(status).toEqual([200, 201]);

    await page.goto(`${base}/`);
    // A click on server-rendered markup before React hydrates does nothing,
    // so retry until the dialog actually opens.
    for (let i = 0; !(await page.$("[role=dialog]")); i++) {
      if (i > 50) throw new Error("the New task dialog never opened");
      await click("+ New task");
      await new Promise((r) => setTimeout(r, 200));
    }
    await page.waitForSelector("[role=dialog] input[required]");
    await page.type("[role=dialog] input[required]", "Browser smoke task");
    // Scoped: an empty board has its own "Create task" button under the dialog.
    await click("Create task", "[role=dialog]");
    await page.waitForFunction(() => !document.querySelector("[role=dialog]"), { timeout: 15_000 });
    const titles = await page.evaluate(async () => (await (await fetch("/api/cards")).json()).map((c: { title: string }) => c.title));
    expect(titles).toContain("Browser smoke task");
  }, 60_000);

  it("signs out everywhere from Settings, and the session stops working", async () => {
    await page.goto(`${base}/settings`);
    await Promise.all([page.waitForNavigation(), click("Sign out everywhere")]);
    expect(new URL(page.url()).pathname).toBe("/login");
    const status = await page.evaluate(async () => (await fetch("/api/cards")).status);
    expect(status).toBe(401);
  }, 30_000);
});
