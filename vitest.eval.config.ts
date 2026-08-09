/**
 * THE GOLDEN EVAL GATE — `npm run eval`.
 *
 * DELIBERATELY SEPARATE FROM `npm test`. `vitest.config.ts` includes
 * `src/**` only, so the eval runner never joins the default suite: its
 * failures are the open acceptance criteria (tickets 054-066) and a red
 * gate must not turn the regression suite red.
 */
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    root: __dirname,
    include: ['eval/**/*.eval.test.{ts,tsx}'],
    // Four of the twelve cases render real components; the pure ones do not
    // care, and one environment keeps the gate a single run.
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
  },
})
