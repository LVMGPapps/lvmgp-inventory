import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico"],
      manifest: {
        name: "LVMGP Inventory",
        short_name: "Inventory",
        description: "LVMGP kitchen inventory — counts, receiving, prep",
        theme_color: "#E0392B",
        background_color: "#101012",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // Precache the built app shell so a cold start in the walk-in still opens.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        navigateFallback: "/index.html",
        // The standalone printables (freezer pull, SOPs) are their own pages — don't
        // hand them index.html when offline.
        navigateFallbackDenylist: [/\.html$/],
        cleanupOutdatedCaches: true,
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        runtimeCaching: [
          {
            // Product photos: show the last-seen image when offline.
            urlPattern: ({ url }) => /\/storage\/v1\/object\//.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "lvmgp-images",
              expiration: { maxEntries: 400, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
