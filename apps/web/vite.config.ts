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
        // Take control immediately on update instead of waiting for every tab
        // to close. Without these, a new build's service worker sits in
        // "waiting" while the old one keeps serving the precached index.html —
        // so a normal Cmd+R shows the OLD app and only Cmd+Shift+R (which
        // bypasses the SW) shows the new one. skipWaiting + clientsClaim make
        // the fresh SW activate and control all open pages right away.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly'  // always fresh for API calls
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
