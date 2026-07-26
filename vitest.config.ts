import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Providers are exercised against recorded fixtures with an injected fetch;
    // nothing in the suite is allowed to touch the network.
    environment: 'node',
    restoreMocks: true,
  },
});
