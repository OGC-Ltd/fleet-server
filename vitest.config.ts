import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // The committed placeholder template, so `npm test` runs on a clean
    // checkout. config/env.ts exits the process when a required key is
    // missing, which used to kill most suites at import.
    env: { DOTENV_CONFIG_PATH: '.env.example', NODE_ENV: 'test' },
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
