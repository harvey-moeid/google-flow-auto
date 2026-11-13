/// <reference types="vite/client" />

/**
 * Only non-secret, public values may be exposed to the browser. Every VITE_* variable is
 * inlined into the shipped JavaScript. `npm run check:secrets` fails the build if a
 * secret-looking VITE_* variable or any other VITE_* name is introduced.
 */
interface ImportMetaEnv {
  /** Optional API origin for local development; leave unset in production (same-origin /api). */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
