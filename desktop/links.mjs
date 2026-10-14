// shell.openExternal hands a URL to whatever the OS registers for its scheme,
// and the pages in the window render text an agent wrote and docs from a repo.
// Only web and mail links leave the window: file:, smb: or another app's own
// protocol would open a file, mount a share or drive that app.
const BROWSER_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/**
 * Where a URL the page asks for should go: "app" stays in the window (the
 * server's own origin), "browser" goes to the system browser, "deny" goes
 * nowhere.
 *
 * @param {string} target
 * @param {string} appOrigin
 * @returns {"app" | "browser" | "deny"}
 */
export function routeUrl(target, appOrigin) {
  let url;
  try {
    url = new URL(target);
  } catch {
    return "deny";
  }
  if (url.origin === appOrigin) return "app";
  return BROWSER_PROTOCOLS.has(url.protocol) ? "browser" : "deny";
}
