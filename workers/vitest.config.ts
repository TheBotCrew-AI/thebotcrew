import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Eval cases live next to the role as *.eval.ts; also pick up plain *.test.ts.
    include: ['src/**/*.eval.ts', 'src/**/*.test.ts'],
    // Live (model-calling) cases self-skip when ANTHROPIC_API_KEY is absent.
    testTimeout: 60_000,
  },
});
