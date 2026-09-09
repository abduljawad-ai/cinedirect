import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { resolve } from 'path';

export default defineConfig({
  // Relative base keeps the static build working both at a domain root and
  // under a subpath (e.g. GitHub Pages <user>.github.io/<repo>), which pairs
  // with the app's hash-based routing.
  base: './',
  plugins: [preact()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../shared'),
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    target: 'es2022',
    minify: 'terser',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/preact') ||
            id.includes('node_modules/@preact/signals')
          ) {
            return 'preact-core';
          }
          return undefined;
        },
      },
    },
    cssCodeSplit: true,
    sourcemap: 'hidden',
  },
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
  },
  css: {
    modules: {
      localsConvention: 'camelCase',
    },
  },
});
