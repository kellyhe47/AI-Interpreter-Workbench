import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    root: __dirname,
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    environmentMatchGlobs: [['src/client/**', 'jsdom']],
    setupFiles: ['./vitest.setup.ts'],
  },
})
