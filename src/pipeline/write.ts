/**
 * Writing a data file so a crash cannot leave half of one.
 *
 * `organisations.json` is half a megabyte and is the file the whole project
 * rests on. Written directly, a crash, a full disk or a machine going to sleep
 * part-way through leaves it truncated — and the next run reads a broken
 * dataset, or, now that the validator has a floor under it, refuses to publish
 * at all. The collector had done this properly for a while; the two other
 * scripts that rewrite the same file had not, and there was no shared place to
 * put it, which is how that happens.
 *
 * The scratch name carries the process id. Sharing one temporary name across
 * processes reintroduces exactly the torn write the rename exists to prevent:
 * the second writer overwrites the first mid-write, and whichever renames last
 * publishes a file the other was halfway through producing.
 */
import { renameSync, writeFileSync } from "node:fs";

export function writeAtomic(path: string, contents: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, contents, "utf8");
  renameSync(temp, path);
}
