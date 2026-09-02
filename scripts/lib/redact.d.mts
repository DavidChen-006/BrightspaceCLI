/**
 * Types for `scripts/lib/redact.mjs`. The implementation is plain ESM so `scripts/e2e.sh` can
 * run it with bare `node` (no tsx, no build step); this sidecar is what lets the hermetic test
 * in `test/live-harness/redact.test.ts` import it under `npm run typecheck`.
 */
export declare const REDACTED: string;
export declare const REDACTED_JWT: string;
export declare function redact(text: string): string;
