import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // `cloudflare:workers` (DurableObject base) isn't resolvable under vitest/node;
      // ConversationDO pulls it in transitively via the mastra re-export. Stub it.
      'cloudflare:workers': fileURLToPath(new URL('./test/stubs/cloudflare-workers.ts', import.meta.url)),
    },
  },
  test: {
    // Eval cases live next to the role as *.eval.ts; also pick up plain *.test.ts.
    include: ['src/**/*.eval.ts', 'src/**/*.test.ts'],
    // Live (model-calling) cases self-skip when ANTHROPIC_API_KEY is absent.
    testTimeout: 60_000,
  },
});
