import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import { Buffer } from 'buffer'

// Make Buffer available globally for bip39
if (typeof window !== 'undefined') {
  (window as any).Buffer = Buffer
}

export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait()
  ],
  optimizeDeps: {
    exclude: ['lucid-cardano'],
    esbuildOptions: {
      target: 'esnext'
    }
  },
  build: {
    target: 'esnext'
  },
  define: {
    'global': 'globalThis',
  },
  resolve: {
    alias: {
      buffer: 'buffer'
    }
  },
  server: {
    port: 3000,
    open: true
  }
})
