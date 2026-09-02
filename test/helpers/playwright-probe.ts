/**
 * Child-process probe for test/auth/no-playwright-load.test.ts: runs one CLI invocation
 * in-process (streams captured, a temp BS_ROOT) and reports whether any playwright-core file
 * ended up in the module cache. `control` imports it on purpose so the check is proven live.
 *
 * ESM `import()` of a CommonJS package goes through the CJS loader, which registers every file
 * in `require.cache`; that is what makes the lazy import observable from outside.
 */
import { createRequire } from 'node:module';
import { run } from '../../src/cli/program.js';

const [mode = 'cli', ...argv] = process.argv.slice(2);
let code = 0;
if (mode === 'control') {
  await import('playwright-core');
} else {
  const sink = { write: () => true };
  const root = process.env.BS_ROOT;
  if (!root) throw new Error('probe: BS_ROOT must point at a temp dir');
  code = await run(argv, {
    stdout: sink,
    stderr: sink,
    env: { BS_ROOT: root },
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stderrIsTTY: false,
  });
}
const require = createRequire(import.meta.url);
const loaded = Object.keys(require.cache).filter((file) => file.includes('playwright-core'));
process.stdout.write(
  `${JSON.stringify({ mode, argv, code, loaded: loaded.length > 0, sample: loaded.slice(0, 2) })}\n`,
);
