import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          codemirror: [
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/commands',
            '@codemirror/lang-sql',
            '@codemirror/language',
            '@codemirror/theme-one-dark',
          ],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  base: '/',
})
