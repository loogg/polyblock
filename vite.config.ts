import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Copies repository JSON schemas (`schemas/*.json`) into `<outDir>/schemas/`
 * during production builds so published `$id` URLs resolve cleanly on static hosts.
 */
function copySchemasPlugin(): Plugin {
  let rootDir = '.';
  let outDir = 'dist';
  return {
    name: 'polyblock-copy-schemas',
    apply: 'build',
    configResolved(config) {
      rootDir = config.root;
      outDir = config.build.outDir || 'dist';
    },
    async closeBundle() {
      const fsMod = 'node:fs';
      const pathMod = 'node:path';
      const fs = (await import(/* @vite-ignore */ fsMod)) as {
        existsSync(p: string): boolean;
        mkdirSync(p: string, opts?: { recursive?: boolean }): void;
        readdirSync(p: string): string[];
        copyFileSync(src: string, dest: string): void;
      };
      const path = (await import(/* @vite-ignore */ pathMod)) as {
        resolve(...segments: string[]): string;
        join(...segments: string[]): string;
      };

      const srcDir = path.resolve(rootDir, 'schemas');
      if (!fs.existsSync(srcDir)) return;
      const destDir = path.resolve(rootDir, outDir, 'schemas');
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        if (file.endsWith('.json')) {
          fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
        }
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), copySchemasPlugin()],
  build: {
    target: 'esnext',
    // Upstream Blockly v13 (`blockly_compressed.js`) lives in a dedicated `vendor-blockly` chunk (~905 kB / 239 kB gzip).
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (!normalized.includes('/node_modules/')) return undefined;
          if (
            normalized.includes('/node_modules/blockly/') ||
            normalized.includes('/node_modules/@blockly/')
          ) {
            return 'vendor-blockly';
          }
          if (
            normalized.includes('/node_modules/react/') ||
            normalized.includes('/node_modules/react-dom/') ||
            normalized.includes('/node_modules/scheduler/')
          ) {
            return 'vendor-react';
          }
          if (normalized.includes('/node_modules/lucide-react/')) {
            return 'vendor-icons';
          }
          return undefined;
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['wasmoon', '@micropython/micropython-webassembly-pyscript'],
  },
  assetsInclude: ['**/*.wasm'],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/plugins/languages/register.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
