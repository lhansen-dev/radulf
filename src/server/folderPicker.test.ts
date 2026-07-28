import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));

// promisify(execFile) picks up the callback style, so mock it that way.
vi.mock("node:child_process", () => ({
  execFile: (
    ...args: [string, string[], object, (err: unknown, out: { stdout: string }) => void]
  ) => mocks.execFile(...args),
}));

const { chooseFolder } = await import("./folderPicker");

function respond(result: { stdout: string } | { error: unknown }) {
  mocks.execFile.mockImplementation((_cmd, _args, _opts, cb) => {
    if ("error" in result) cb(result.error, { stdout: "" });
    else cb(null, result);
  });
}

const originalPlatform = process.platform;

function setPlatform(platform: string) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
  vi.clearAllMocks();
});

describe("chooseFolder", () => {
  it("returns the picked path without the trailing slash", async () => {
    setPlatform("darwin");
    respond({ stdout: "/Users/dev/code/radulf/\n" });
    await expect(chooseFolder()).resolves.toBe("/Users/dev/code/radulf");
  });

  it("returns null when the user cancels", async () => {
    setPlatform("darwin");
    respond({ stdout: "\n" });
    await expect(chooseFolder()).resolves.toBeNull();
  });

  it("reports a timed-out dialog as a client error", async () => {
    setPlatform("darwin");
    respond({ error: Object.assign(new Error("killed"), { killed: true }) });
    await expect(chooseFolder()).rejects.toThrow(/timed out/);
  });

  it("surfaces osascript's stderr when the dialog cannot open", async () => {
    setPlatform("darwin");
    respond({ error: Object.assign(new Error("exit 1"), { stderr: "no window server\n" }) });
    await expect(chooseFolder()).rejects.toThrow(/no window server/);
  });

  it("names the signal when the dialog is killed without any stderr", async () => {
    setPlatform("darwin");
    respond({ error: Object.assign(new Error("Command failed"), { signal: "SIGTERM" }) });
    await expect(chooseFolder()).rejects.toThrow(/SIGTERM/);
  });

  it("refuses to run off macOS", async () => {
    setPlatform("linux");
    await expect(chooseFolder()).rejects.toThrow(/macOS/);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
