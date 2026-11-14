// Builds the main process, the preload script and both pages into dist/.
import { build } from 'esbuild';
import fs from 'node:fs';
import { build as viteBuild } from 'vite';

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['electron', 'onnxruntime-node'], alias: { sharp: './src/main/voice/sharp-stub.ts' }, sourcemap: false, logLevel: 'info' };
await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' });
await build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js' });
await viteBuild({ logLevel: 'warn' });
// kokoro-js looks for its voice style files next to the bundle, in ../voices.
fs.cpSync('node_modules/kokoro-js/voices', 'dist/voices', { recursive: true });
console.log('build complete');
