/**
 * "New version – reload" only when there is one: a waiting worker whose build names the page's own entry script is
 * the build the page already runs (a hard reload passes the old worker by).
 */
import { isCurrentBuild } from './pwa'

describe('a waiting worker', () => {
  const shell = ['/assets/index-AbC123.js', '/assets/vendor-x.js', '/manifest.webmanifest']

  it('is this page’s own build when its files name the entry script', () => {
    expect(isCurrentBuild(shell, '/assets/index-AbC123.js')).toBe(true)
    expect(isCurrentBuild(shell, `${window.location.origin}/assets/index-AbC123.js`)).toBe(true)
  })

  it('is a new build otherwise, or when it cannot tell', () => {
    expect(isCurrentBuild(shell, '/assets/index-Old999.js')).toBe(false)
    expect(isCurrentBuild(null, '/assets/index-AbC123.js')).toBe(false)
    expect(isCurrentBuild(shell, null)).toBe(false)
  })
})
