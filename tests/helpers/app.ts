/**
 * Lazy app factory for integration tests.
 * Call AFTER all vi.mock() declarations in the test file.
 */
export async function buildApp() {
  const { createApp } = await import('../../src/app.js')
  return createApp()
}
