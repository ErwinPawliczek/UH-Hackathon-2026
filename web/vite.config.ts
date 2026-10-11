/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The catalog of process recipes lives with the engine
  // (../engine/data/catalog/processes/*.json) and is imported into the bundle
  // as the single source of truth — allow the dev server to read it. `vite
  // build` resolves outside-root imports without extra config.
  server: {
    fs: {
      allow: ['..'],
    },
    // Dev-only: forward the hosted-engine API to a locally running crx-server
    // (`cmake --build build/hosted && ./build/hosted/crx-server --port 8080`).
    // The server sends no CORS headers, so hosted mode must stay same-origin.
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
  test: {
    environment: 'node',
  },
});
