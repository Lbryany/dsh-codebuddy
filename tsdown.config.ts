import { defineConfig } from 'tsdown'

export default defineConfig([{
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  target: 'node22.19',
  dts: true,
  clean: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-commands',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-client-connection',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-ai/compat',
    ],
  },
}, {
  entry: { client: 'src/client.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser',
  target: 'es2022', dts: false, clean: false,
  deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives'] },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@lbryany/dsh-codebuddy", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}])
