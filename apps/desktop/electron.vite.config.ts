import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        // workspace packages are bundled into main; native modules stay external
        external: ['@lydell/node-pty'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        external: [],
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
  },
});
