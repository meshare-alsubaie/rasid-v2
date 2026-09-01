/**
 * The public half of the notification key pair.
 *
 * It is committed, and that is deliberate. A VAPID public key is public by
 * construction: the browser needs it to create a subscription, so it is
 * shipped inside the application bundle to every visitor, and it is useless to
 * anyone without the private half. Keeping it in a repository secret adds no
 * secrecy at all - and it adds a failure that already happened here.
 *
 * The site was deployed with the secret unset. The build succeeded, the page
 * loaded, and the only sign was one line inside a diagnostics panel saying the
 * key was missing. Push notifications - the thing this application exists to
 * deliver - were simply off, and would have stayed off until someone opened
 * that panel and read it. A configuration that can be silently absent is a
 * configuration that will be silently absent.
 *
 * The private key is not here and never will be. It lives in `.env` on the
 * machine that sends the notifications, which is gitignored, and it is what
 * actually signs a push.
 *
 * To rotate: run `npm run vapid:new`, which writes a new pair to `.env` and
 * prints the public half to paste here. Every device then has to subscribe
 * again, because a subscription is bound to the key that created it.
 */
const BUILT_IN = "BIDLwMfSoHNbRgZaPn_uvVTWZNdQqrUXYOUhrtzSOZx7o5n9DeX9rz-3rNro0VJJ0-8VWwoC66EgCcBmoClrWJE";

/**
 * The environment still wins, so a fork or a second deployment can use its own
 * keys without editing this file.
 *
 * Read defensively because this module has two callers in two worlds. In the
 * browser Vite replaces `import.meta.env.VITE_*` at build time; under Node,
 * where the gate imports this file to check the key is present, `import.meta`
 * has no `env` at all and the plain form throws on load. A key that only
 * exists in one of the two is a key the test cannot check.
 */
const fromEnv = (import.meta as { env?: Record<string, string | undefined> }).env
  ?.VITE_VAPID_PUBLIC_KEY;

export const VAPID_PUBLIC_KEY: string = fromEnv?.trim() || BUILT_IN;
