/**
 * `VITE_FAKE=1 npm run dev`: the fake server answers instead of a real one. Imported first in `main.tsx`, before
 * anything asks the server; a normal build leaves it out (the condition is false at build time).
 */
import { installFake } from './test/devFake'

if (import.meta.env.VITE_FAKE === '1') installFake()
