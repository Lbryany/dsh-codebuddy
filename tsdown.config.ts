import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  target: 'node22.19',
  dts: true,
  clean: true,
  sourcemap: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-llm',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-ai/compat',
    ],
  },
})
