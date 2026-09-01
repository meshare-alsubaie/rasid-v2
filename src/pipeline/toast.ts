/**
 * The notification that reaches him while he is playing.
 *
 * Web push needs a browser process alive to receive it, and the owner is
 * usually in a full-screen game with no browser open. A Windows toast does not:
 * it is delivered by the operating system, it appears over the game, and it
 * survives in the Action Center if he misses it.
 *
 * This is a second channel, not a replacement. The phone still matters - it is
 * what reaches him away from the desk - and the two fail for completely
 * different reasons, which is the point of having both.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** XML, not HTML: five characters, and getting them wrong drops the toast. */
const escapeXml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export interface ToastResult {
  ok: boolean;
  reason: string | null;
}

/**
 * Show one toast. Never throws, and never blocks a round.
 *
 * A notification channel that can take the run down with it is worse than no
 * channel: the alert is the last step, and everything before it - the fetch,
 * the hashes, the verdicts - is already worth keeping.
 */
export async function showToast(title: string, body: string, timeoutMs = 10_000): Promise<ToastResult> {
  if (process.platform !== "win32") {
    return { ok: false, reason: "not Windows" };
  }

  /*
   * The text goes through a UTF-8 file rather than the command line.
   *
   * Arabic on a PowerShell command line from Node is decoded by the console
   * codepage on the way in, which mangles it. A file read with -Encoding utf8
   * has no such step. It also keeps scripts/toast.ps1 free of any character
   * outside ASCII, which the parser depends on.
   */
  const dir = mkdtempSync(join(tmpdir(), "rasid-toast-"));
  const payload = join(dir, "toast.xml");
  const xml =
    `<toast activationType="protocol" launch="https://meshare-alsubaie.github.io/rasid-v2/">` +
    `<visual><binding template="ToastGeneric">` +
    `<text>${escapeXml(title)}</text>` +
    `<text>${escapeXml(body)}</text>` +
    `</binding></visual>` +
    `<audio src="ms-winsoundevent:Notification.Default"/>` +
    `</toast>`;

  try {
    writeFileSync(payload, xml, "utf8");
    return await new Promise<ToastResult>((resolve) => {
      const child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "scripts/toast.ps1", payload],
        { windowsHide: true },
      );
      let out = "";
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));

      const timer = setTimeout(() => {
        child.kill();
        resolve({ ok: false, reason: `toast timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? { ok: true, reason: null } : { ok: false, reason: out.trim() || `exit ${code}` });
      });
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp file is not worth a failed notification.
    }
  }
}
