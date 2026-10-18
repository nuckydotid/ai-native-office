import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  preview: { port: 4173, strictPort: true, host: '127.0.0.1' },
  server: { port: 5173 },
});
