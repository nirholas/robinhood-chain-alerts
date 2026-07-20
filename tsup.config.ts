import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'events/index': 'src/events/index.ts',
    'rules/index': 'src/rules/index.ts',
    'notifiers/index': 'src/notifiers/index.ts',
    'bot/index': 'src/bot/index.ts',
    'tiers/index': 'src/tiers/index.ts',
    'service/index': 'src/service/index.ts',
    'service/main': 'src/service/main.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  external: ['viem', 'hoodchain', 'hoodkit'],
})
