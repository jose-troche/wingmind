import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SharedArrayBuffer needs cross-origin isolation, in dev as in production
// (production gets the same headers from public/_headers).
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  define: {
    // test hooks exist only in builds made with VITE_TEST_HOOKS=1; production strips them
    __TEST_HOOKS__: JSON.stringify(process.env.VITE_TEST_HOOKS === '1'),
  },
  server: {
    headers: isolation,
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
});
