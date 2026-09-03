/**
 * Nothing about this machine goes into the dataset.
 *
 * The dataset is published. Every file in `data/` is committed and served from
 * a public URL, so anything written into it is written for strangers, and an
 * error message is the one field nobody thinks of that way — it arrives from a
 * library, gets stored verbatim, and carries whatever the library felt like
 * mentioning. What it mentioned here was the owner's Windows account name, in
 * thirty-three published rows:
 *
 *   headless chromium unavailable (browserType.launch: Executable doesn't
 *   exist at C:\Users\GIGABITE\AppData\Local\ms-playwright\...)
 *
 * The message is worth keeping; the path is not. Redacting at the point where
 * an error becomes data is the only place that holds, because by the time it
 * reaches the interface it has already been committed and pushed.
 */

/*
 * Windows drive paths, UNC paths, and POSIX home directories.
 *
 * The lookbehinds are load-bearing, and their absence did real damage. Without
 * `(?<![A-Za-z])` the drive-letter rule matches the `s:` of `https:` followed by
 * `//`, so a first attempt at this rewrote 478 source URLs into
 * `http[redacted]/student-opportunities` across the dataset. A redactor that
 * eats the data it is protecting is worse than the leak. Hence
 * `test:redact`, which asserts on real URLs from the live file.
 */
const PATHS: RegExp[] = [
  // C:\Users\name\... and C:/Users/name/... but never the tail of "https://".
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]+(?:[^\s\\/:*?"<>|]+[\\/]+)*[^\s\\/:*?"<>|]*/g,
  // \\server\share\...
  /(?<![\w\\])\\\\[^\s\\]+(?:\\[^\s\\]+)*/g,
  // /home/name/... at the start of a path, never a path segment inside a URL.
  /(?<![\w/:])\/(?:home|Users|root)\/[^\s:"']+/g,
];

/**
 * The same message with any local filesystem path replaced.
 *
 * The replacement keeps the last segment where there is one, because "the file
 * chromium.exe is missing" is the useful half of the sentence and it gives
 * nothing away.
 */
export function redactPaths(message: string): string {
  let out = message;
  for (const re of PATHS) {
    out = out.replace(re, (match) => {
      const tail = match.split(/[\\/]+/).filter(Boolean).at(-1) ?? "";
      // A bare drive root, or a path ending in a separator, has no useful tail.
      return /^[A-Za-z]:$/.test(tail) || tail === "" ? "[مسار محلي]" : `[مسار محلي]/${tail}`;
    });
  }
  return out;
}

/**
 * True when a string still names something about this machine.
 *
 * Used by the privacy gate so the check is the same rule as the redaction, and
 * cannot drift away from it.
 */
export function namesThisMachine(text: string): boolean {
  return PATHS.some((re) => new RegExp(re.source).test(text));
}
