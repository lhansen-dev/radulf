import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ClientError } from "./clientError";

const execFileAsync = promisify(execFile);

/** How long the dialog may stay open before we stop waiting on the user. */
const PICKER_TIMEOUT_MS = 5 * 60_000;

// Top-level `activate` brings osascript itself to the front, so the dialog
// lands above the browser instead of behind it — and unlike telling Finder or
// System Events to do it, that needs no Automation (TCC) grant. Cancelling
// `choose folder` raises -128, which we turn into an empty selection.
const CHOOSE_FOLDER_SCRIPT = `try
	activate
	set chosen to choose folder with prompt "Choose a git repository"
	POSIX path of chosen
on error number -128
	""
end try`;

/**
 * Open the native folder chooser on the machine running the server and return
 * the picked absolute path, or null when the user cancels. Only meaningful for
 * a local install: the dialog appears on the host's screen, not the browser's.
 */
export async function chooseFolder(): Promise<string | null> {
  if (process.platform !== "darwin") {
    throw new ClientError(
      "the folder picker needs macOS on the machine running Radulf — type the path instead",
    );
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("osascript", ["-e", CHOOSE_FOLDER_SCRIPT], {
      encoding: "utf8",
      timeout: PICKER_TIMEOUT_MS,
    }));
  } catch (cause) {
    const { killed, stderr, signal, message } = cause as {
      killed?: boolean;
      stderr?: string;
      signal?: string;
      message?: string;
    };
    if (killed) throw new ClientError("the folder picker timed out — type the path instead");
    // No window server (headless/ssh session), osascript missing, or the
    // dialog was killed out from under us — osascript says nothing then, so
    // fall back to the signal/message rather than an empty reason.
    const detail = (stderr ?? "").trim() || signal || message || "unknown error";
    throw new ClientError(`could not open the folder picker: ${detail}`);
  }
  const picked = stdout.trim();
  if (!picked) return null;
  // `choose folder` returns a trailing slash; repos are stored as bare paths.
  return picked.length > 1 ? picked.replace(/\/+$/, "") : picked;
}
