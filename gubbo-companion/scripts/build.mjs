// Builds the main process, the preload script and both pages into dist/.
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], sourcemap: false, logLevel: 'info' };
await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' });
await build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js' });
await viteBuild({ logLevel: 'warn' });
console.log('build complete');
