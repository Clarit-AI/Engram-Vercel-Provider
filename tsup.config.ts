import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/snapshots/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  external: ['ai', '@ai-sdk/provider', '@ai-sdk/provider-utils', '@ai-sdk/openai-compatible'],
});
