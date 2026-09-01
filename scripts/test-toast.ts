/**
 * The channel that reaches him inside a game.
 *
 * Web push needs a live browser, and he is usually in a full-screen match with
 * none open. This one is delivered by Windows itself. It is the only channel
 * that can reach him at the desk with nothing running, so its failure modes
 * matter more than its success: a notifier that throws takes the round with it,
 * and everything before the notification - the fetch, the hashes, the verdicts
 * - is already worth keeping.
 *
 * One real toast is shown. That is the point: a notification channel tested
 * only against a mock proves nothing about the thing that has to appear over a
 * game at two in the morning.
 *
 *   npm run test:toast
 */
import { readFileSync } from "node:fs";
import { showToast } from "../src/pipeline/toast";

let failures = 0;
const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("the PowerShell half stays parseable, which is not decoration");
{
  const source = readFileSync("scripts/toast.ps1", "utf8");
  const nonAscii = [...source].filter((ch) => ch.codePointAt(0)! > 127);
  /*
   * Windows PowerShell 5.1 reads a .ps1 with no byte-order mark in the system
   * codepage, so one character outside ASCII stops the parser before the first
   * line runs. That has already killed the scheduled collection here twice, and
   * silently: the log is written from inside the script.
   *
   * This is why the Arabic goes through a file. test:scripts checks the same
   * property across every .ps1; it is repeated here because this particular
   * file is the one that is *about* Arabic text.
   */
  check("scripts/toast.ps1 is pure ASCII", nonAscii.length === 0, `${nonAscii.length} outside ASCII`);
  check("and it reads the payload as UTF-8", /-Encoding\s+utf8/.test(source));
  check("and it never hard-codes the message", !/[؀-ۿ]/.test(source));
}

console.log("\na real toast, on this machine");
{
  const started = Date.now();
  const r = await showToast(
    "راصد ٢ — اختبار القناة",
    "الهيئة الوطنية للأمن السيبراني · درجة ٩٥ · تُغلق بعد خمسة أيام",
  );
  check("Windows accepted it", r.ok, r.reason ?? "");
  check("and it did not block the round", Date.now() - started < 15_000, `${Date.now() - started}ms`);
}

console.log("\nfailure is reported, never thrown");
{
  /*
   * The five XML characters, which are the realistic way this breaks: an
   * announcement title containing & or < would produce invalid XML, the API
   * would refuse the whole notification, and the alert would vanish with no
   * error anywhere near the reader.
   */
  const r = await showToast('عنوان فيه & و < و "اقتباس"', "نصّ فيه <وسم> و & أيضاً");
  check("a title full of XML characters still goes out", r.ok, r.reason ?? "");
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
