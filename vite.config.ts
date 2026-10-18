import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    // `npm run dev` finds the team server next door on 8080 (see `demoOrigin` in src/web.ts).
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/team-server/**'],
    },
  },
  build: {
    target: 'safari15',
    minify: 'esbuild',
    outDir: 'dist',
  },
});
