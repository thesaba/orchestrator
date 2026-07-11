import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  resolve: {
    alias: {
      path: 'path-browserify'
    }
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Orchestrator',
        short_name: 'Orchestrator',
        description: 'Laravel deployment panel',
        theme_color: '#1a1a2e',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      },
      workbox: {
        // Activate a new build's service worker immediately instead of leaving
        // it "waiting" behind the old one.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // IMPORTANT: do NOT set navigateFallback. That option makes the SW serve
        // the *precached* index.html for every navigation (cache-first), which
        // is exactly why a normal Cmd+R kept showing an old build until a second
        // refresh. Hashed JS/CSS are still precached (immutable, safe); only the
        // HTML shell is handled below, network-first, so a reload is always the
        // current build when online and falls back to the last cached shell only
        // when offline.
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly' // never cache API responses
          },
          {
            // Page navigations (the HTML document) — always try the network
            // first so a refresh shows the current build; cache is a fallback.
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'html-shell',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 4 }
            }
          }
        ]
      }
    })
  ],
  build: {
    // Split large vendor libraries into separate, long-term-cacheable chunks so
    // an app update doesn't force users to re-download React/Polaris/etc.
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          polaris: ['@shopify/polaris', '@shopify/polaris-icons'],
          charts: ['recharts'],
          editor: ['@monaco-editor/react'],
          terminal: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-attach']
        }
      }
    }
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
        ws: true
      }
    }
  }
})
