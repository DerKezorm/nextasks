// The pages of the shared account module that nextasks' older tests did not reach, against the fake server: a session
// that ends while a page is open asks to sign in again over the page ("Session expired", konten 0.3.5), and
// "Forgot your password?" says who can help where no mail can go.
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { SIGNED_OUT_EVENT } from '../api/client'
import { smallWorld } from '../test/fakeServer'
import { click, mount, settle, submit, type, unmount, where } from '../test/harness'

afterEach(async () => {
  await unmount()
})

describe('a session that ends while a page is open', () => {
  it('asks to sign in again over the page, which stays where it was and goes on', async () => {
    const { server, home } = smallWorld()
    const page = await mount(server, `/lists/${home}`)
    server.session = null
    await act(async () => void window.dispatchEvent(new Event(SIGNED_OUT_EVENT)))
    await settle()
    const dialog = document.querySelector('[data-testid="session-expired"]')!
    expect(dialog.textContent).toContain('Session expired')
    expect(where.path).toBe(`/lists/${home}`)
    await type(dialog.querySelector('input[type="password"]'), 'password-123')
    await submit(dialog.querySelector('input[type="password"]'))
    expect(document.querySelector('[data-testid="session-expired"]')).toBeNull()
    expect(server.session).not.toBeNull()
    expect(where.path).toBe(`/lists/${home}`)
    expect(page.querySelector('main')).not.toBeNull()
  })

  it('leads to the sign-in page for somebody else', async () => {
    const { server, home } = smallWorld()
    await mount(server, `/lists/${home}`)
    server.session = null
    await act(async () => void window.dispatchEvent(new Event(SIGNED_OUT_EVENT)))
    await settle()
    await click(document.querySelector('[data-testid="session-leave"]'))
    expect(where.path).toMatch(/^\/login\?next=.*&ended=1$/)
  })
})

describe('a forgotten password', () => {
  it('without a mail server says that the operator makes a link', async () => {
    const { server } = smallWorld()
    server.session = null
    const page = await mount(server, '/forgot')
    expect(page.textContent).toContain('The operator can make you a link under Accounts to set a new password.')
    expect(page.querySelector('input')).toBeNull()
  })

  it('with a mail server takes a username or email and answers the same whatever was typed', async () => {
    const { server } = smallWorld()
    server.session = null
    server.settings.smtp_host = 'mail.example.com'
    server.settings.public_url = 'https://tasks.example.com'
    const login = await mount(server, '/login')
    expect([...login.querySelectorAll('a')].find((link) => link.textContent === 'Forgot your password?')?.getAttribute('href')).toBe('/forgot')
    await unmount()
    const page = await mount(server, '/forgot')
    await type(page.querySelector('input[autocomplete="username"]'), 'nobody@example.com')
    await submit(page.querySelector('input[autocomplete="username"]'))
    expect(page.textContent).toContain('If there is an account with an address for this, a link is on its way.')
  })
})
