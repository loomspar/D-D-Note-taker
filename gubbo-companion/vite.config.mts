import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
    rollupOptions: { input: { panel: path.resolve(import.meta.dirname, 'src/renderer/panel.html'), avatar: path.resolve(import.meta.dirname, 'src/renderer/avatar.html') } },
  },
});
