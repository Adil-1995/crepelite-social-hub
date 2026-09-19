// Bundles the Cloud Functions source together with ../shared into lib/index.js.
// Runtime dependencies listed in package.json stay external (installed by Cloud Build);
// shared code, zod and luxon are inlined so the deployed package is self-contained.
import { build, context } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));

const options = {
  entryPoints: [path.join(here, 'src/index.ts')],
  outfile: path.join(here, 'lib/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: Object.keys(pkg.dependencies ?? {}),
  alias: { '@shared': path.join(here, '../shared/src') },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
