import { pageOrder, PAGES } from '../../vendor/nexkonten/konten'

/** The parts of the pages Profile and Security, top to bottom: the module's in its order, then nextasks' own
 * (`pageOrder`, konten 0.3.6): in the profile "Sign out" (the time zone stands in the profile card under the
 * language, installing moved to Connections); under security the sign-in providers. The vitest `nexkonten.test.ts` holds the pages to it. */
export const APP_PAGES = {
  profile: pageOrder('profile', ['signOut']),
  security: pageOrder('security', ['providers']),
} as const

/** One part of the module's pages (`PAGES`) by its name: its title, hint and buttons. */
export const pagePart = (page: keyof typeof PAGES, name: string) => PAGES[page].parts.find((entry) => entry.part === name)!
