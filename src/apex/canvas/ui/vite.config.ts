// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/ui/vite.config.ts — JAL-014 Canvas Frontend Vite config
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Serve and build under /canvas/ so asset paths are correct when served by CanvasServer
  base: '/canvas/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
