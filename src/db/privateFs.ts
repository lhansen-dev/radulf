import fs from "node:fs";

/**
 * Owner-only modes for Radulf's state, applied the same way everywhere.
 *
 * A chmod can fail on a path Radulf does not own, such as a shared volume
 * mounted with another uid. That is fine when the path is already private,
 * so a failure is fatal only while the path stays visible to other accounts.
 * Kept out of `@/db` itself so modules that tests load under a mocked `@/db`
 * can still use it.
 */

/** chmod 0600 and refuse to continue if sensitive state remains exposed. */
export function tighten(file: string): void {
  if (!fs.existsSync(file)) return;
  try {
    fs.chmodSync(file, 0o600);
  } catch (cause) {
    if ((fs.statSync(file).mode & 0o077) !== 0) throw cause;
  }
}

/** Create a private state directory and tighten installs made under old umasks. */
export function privateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch (cause) {
    if ((fs.statSync(dir).mode & 0o077) !== 0) throw cause;
  }
}
