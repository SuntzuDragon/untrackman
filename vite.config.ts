import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // No production sourcemap: it added 2.6 MB to every deploy and the source
    // is public on GitHub anyway. Run `pnpm dev` to debug against real sources.
    sourcemap: false,
    // The single chunk is ~210 kB gzipped, dominated by Plot and d3. Measured
    // as fine at 50x the current data volume, so the default 500 kB warning is
    // noise here rather than a signal.
    chunkSizeWarningLimit: 700,
  },
});
