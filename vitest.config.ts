import { defineConfig } from 'vitest/config';

const runOptionalTests = process.env.JEEVES_RUN_OPTIONAL_TESTS === 'true';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts', 'apps/**/src/**/*.test.tsx'],
    exclude: ['**/dist/**', '**/node_modules/**', ...(runOptionalTests ? [] : ['**/*.optional.test.ts'])],
  },
});
