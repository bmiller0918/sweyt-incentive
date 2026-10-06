// Bundles the server (and the workspace `shared` package) into dist/index.js.
// Third-party deps stay external and are loaded from node_modules at runtime.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith('@commissions/'));

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/index.js',
  external,
  sourcemap: true,
  logLevel: 'info',
});
