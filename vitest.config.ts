import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/config/**',
        'src/core/types/**',
      ],
      thresholds: { lines: 70, functions: 70, branches: 60 },
    },
    // Separate pools prevent module-mock bleed between test files
    pool: 'forks',
  },
  resolve: {
    alias: { '@': resolve(import.meta.dirname, './src') },
  },
})
