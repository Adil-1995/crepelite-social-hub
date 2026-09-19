import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import Components from 'unplugin-vue-components/vite';
import { PrimeVueResolver } from '@primevue/auto-import-resolver';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    // PrimeVue components resolve on use, so only the ones the app actually
    // renders reach the bundle (no global registration of all 80+ components).
    Components({
      dts: 'src/components.d.ts',
      resolvers: [PrimeVueResolver()],
      dirs: ['src/components'],
      extensions: ['vue'],
      include: [/.vue$/, /.vue?vue/],
    }),
    VitePWA({
      // The app shows its own "Update available" prompt (see src/app/pwa.ts).
      registerType: 'prompt',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: {
        id: '/',
        name: 'CrepeLite Social Hub',
        short_name: 'CrepeLite Social',
        description: 'Plan, schedule and publish CrepeLite content to every social network.',
        lang: 'en',
        start_url: '/dashboard',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#FFF8EF',
        theme_color: '#B4562A',
        categories: ['productivity', 'business', 'social'],
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Create post', short_name: 'Create', url: '/compose', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Calendar', url: '/calendar', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      devOptions: { enabled: false, type: 'module' },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared/src', import.meta.url)),
    },
  },
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) return 'firebase';
          if (id.includes('node_modules/primevue') || id.includes('node_modules/@primeuix')) return 'primevue';
          if (id.includes('node_modules/luxon') || id.includes('node_modules/zod')) return 'vendor-utils';
          return undefined;
        },
      },
    },
  },
});
