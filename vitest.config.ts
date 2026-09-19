import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
  '@shared': fileURLToPath(new URL('./shared/src', import.meta.url)),
};

/**
 * Test projects.
 *
 * `shared`, `functions` and `web` are pure unit tests and run anywhere.
 * `rules` and `integration` need the Firebase Emulator Suite (and therefore a
 * JDK) and are run separately by `npm run test:emulator`, which is why they are
 * excluded from the default `npm test`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'shared',
          environment: 'node',
          include: ['tests/shared/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'functions',
          environment: 'node',
          include: ['tests/functions/**/*.test.ts'],
        },
      },
      {
        plugins: [vue()],
        resolve: { alias },
        test: {
          name: 'web',
          environment: 'happy-dom',
          include: ['tests/web/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'rules',
          environment: 'node',
          include: ['tests/rules/**/*.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
