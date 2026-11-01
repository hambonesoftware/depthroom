import { defineConfig } from 'vite';

export default defineConfig({
  // Relative URLs keep static builds working at username.github.io/repository/.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1100,
  },
});