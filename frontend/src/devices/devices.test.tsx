// My account › Connections › "Devices" as nexnotes' (`devices/devices.test.tsx` there), against the fake server: the card
// first, before the keys; every paired device with its name and last contact; "Disconnect" only after a question;
// "Connect iPhone or iPad" opens the QR code with the steps, the address and the short code; the operator's switches
// answer in the dialog.
import { afterEach, describe, expect, it } from 'vitest'

import { smallWorld } from '../test/fakeServer'
import { button, click, mount, settle, unmount } from '../test/harness'

afterEach(unmount)

const card = (page: HTMLElement) => page.querySelector('#devices') as HTMLElement
const dialog = () => document.querySelector('[data-testid="devices-connect-dialog"]') as HTMLElement | null

describe('My account › Connections › Devices', () => {
  it('stands first, before the keys, and lists every device with its name and last contact', async () => {
    const { server, robin, alex } = smallWorld()
    const hour = new Date(Date.now() - 3_600_000).toISOString()
    server.devices.push({ id: 'phone', account: robin, name: 'Robin’s iPhone', created_at: hour, last_seen: hour })
    server.devices.push({ id: 'pad', account: robin, name: 'iPad', created_at: hour, last_seen: null })
    server.devices.push({ id: 'other', account: alex, name: 'Alex’s iPhone', created_at: hour, last_seen: hour })
    const page = await mount(server, '/settings/connections')
    const cards = [...page.querySelectorAll('section[id]')].map((section) => section.id)
    // The order of the plan "Einstellungen" (Verbindungen): devices, installing on this device, the API keys, the AI
    // tools (MCP, since mcp 1.1.0).
    expect(cards).toEqual(['devices', 'install', 'api-keys', 'ai-tools'])
    expect(card(page).querySelector('h2')?.textContent).toBe('Devices')
    const rows = [...card(page).querySelectorAll('[data-testid="device-row"]')]
    expect(rows.map((row) => row.querySelector('[data-testid="device-name"]')?.textContent)).toEqual(['Robin’s iPhone', 'iPad'])
    expect(rows[0].querySelector('[data-testid="device-meta"]')?.textContent).toBe('last seen 1 hour ago')
    expect(rows[1].querySelector('[data-testid="device-meta"]')?.textContent).toBe('not seen yet')
    // The server names no kind and nothing about notifications: no such words.
    expect(card(page).textContent).not.toMatch(/iOS app|notifications on/)
    for (const row of rows) {
      expect(row.querySelector('svg')).not.toBeNull()
      // A small danger button with its symbol and words (ui 1.1.0).
      const button = row.querySelector('button')!
      expect([button.getAttribute('data-kind'), button.getAttribute('data-size'), button.getAttribute('data-icon')]).toEqual(['danger', 'sm', 'Unplug'])
    }
    expect(card(page).querySelector('[data-testid="devices-none"]')).toBeNull()
    expect(card(page).querySelector('[data-testid="devices-connect"]')?.textContent).toBe('Connect iPhone or iPad')
    expect(card(page).querySelector('[data-testid="devices-connect"]')?.getAttribute('data-kind')).toBe('primary')
    // The symbol as nexnotes' (E39): the device, not the code it shows.
    expect(card(page).querySelector('[data-testid="devices-connect"]')?.getAttribute('data-icon')).toBe('Smartphone')
  })

  it('says so when no device is connected, the button to connect stays', async () => {
    const { server } = smallWorld()
    const page = await mount(server, '/settings/connections')
    expect(card(page).querySelector('[data-testid="devices-none"]')?.textContent).toBe('No device connected yet.')
    expect(card(page).querySelector('[data-testid="devices-list"]')).toBeNull()
    expect(card(page).querySelector('[data-testid="devices-connect"]')).not.toBeNull()
  })

  it('disconnects a device only after asking, "Cancel" keeps it', async () => {
    const { server, robin } = smallWorld()
    server.devices.push({ id: 'phone', account: robin, name: 'Test phone', created_at: new Date().toISOString(), last_seen: null })
    const page = await mount(server, '/settings/connections')
    const disconnect = card(page).querySelector('[data-testid="device-disconnect"]')!
    expect(disconnect.textContent).toBe('Disconnect')
    expect(disconnect.getAttribute('aria-label')).toBe('Disconnect “Test phone”')
    await click(disconnect)
    let asked = document.querySelector('[data-testid="confirm-dialog"]')!
    const window = asked.closest('[role="dialog"]') ?? asked
    const named = window.getAttribute('aria-label') ?? document.getElementById(window.getAttribute('aria-labelledby') ?? '')?.textContent
    expect(named).toBe('Disconnect “Test phone”?')
    expect(asked.textContent).toContain('From now on the device cannot reach your tasks. To connect it again, scan a new code.')
    // "Cancel" first, the danger on the right.
    const buttons = [...asked.querySelectorAll('button[data-kind]')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Disconnect'])
    expect(buttons[1].getAttribute('data-kind')).toBe('danger')
    await click(buttons[0])
    await settle()
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull()
    expect(server.devices).toHaveLength(1)
    expect(server.requests.some((r) => r.method === 'DELETE' && r.path.startsWith('/api/app-devices/'))).toBe(false)

    await click(card(page).querySelector('[data-testid="device-disconnect"]'))
    asked = document.querySelector('[data-testid="confirm-dialog"]')!
    await click(asked.querySelectorAll('button[data-kind]')[1])
    await settle()
    expect(server.requests.some((r) => r.method === 'DELETE' && r.path === '/api/app-devices/phone')).toBe(true)
    expect(server.devices).toHaveLength(0)
    expect(card(page).querySelector('[data-testid="devices-none"]')).not.toBeNull()
  })

  it('opens the QR code with three steps, the address and the short code; closing withdraws the code, renewing makes a new one', async () => {
    const { server } = smallWorld()
    server.settings.public_url = 'https://tasks.example.com'
    const page = await mount(server, '/settings/connections')
    expect(dialog()).toBeNull()
    await click(card(page).querySelector('[data-testid="devices-connect"]'))
    await settle()
    const open = dialog()!
    // The window of the ui kit (E31), named by its title.
    const shell = open.closest('[role="dialog"]')!
    expect(shell.getAttribute('aria-label') ?? document.getElementById(shell.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Connect iPhone or iPad')
    expect(open.querySelector('[data-testid="devices-qr"]')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(open.querySelector('[data-testid="devices-qr"]')?.getAttribute('alt')).toBe('QR code to connect')
    expect([...open.querySelectorAll('ol li')].map((li) => li.textContent)).toEqual([
      'Open nextasks on the iPhone or iPad.',
      'Tap “Connect a server” and scan the code.',
      'Done. Your tasks load, and the sign-in travels to your other devices through your Apple ID.',
    ])
    const [first] = [...server.pairings.values()]
    const address = open.querySelector('[data-testid="devices-address"]')!
    expect(address.textContent).toBe(`Without a camera: in the app under “Code”, enter the address tasks.example.com and the code ${first.code}.`)
    expect(open.querySelector('[data-testid="devices-code"]')?.textContent).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(open.textContent).toContain('Valid for 10 minutes')
    expect(document.querySelector('[data-testid="devices-renew"]')?.textContent).toBe('new code')

    await click(open.querySelector('[data-testid="devices-renew"]'))
    await settle()
    expect(server.pairings.has(first.id)).toBe(false)
    expect(server.pairings.size).toBe(1)
    const [second] = [...server.pairings.values()]
    expect(second.id).not.toBe(first.id)

    await click(dialog()!.querySelector('[data-testid="devices-close"]'))
    await settle()
    expect(dialog()).toBeNull()
    expect(server.pairings.size).toBe(0)
  })

  it('closes itself once the iPhone took the code, the device then in the list', async () => {
    const { server } = smallWorld()
    server.settings.public_url = 'https://tasks.example.com'
    const page = await mount(server, '/settings/connections')
    await click(card(page).querySelector('[data-testid="devices-connect"]'))
    await settle()
    server.connectPairing([...server.pairings.keys()][0], 'Test phone')
    await new Promise((resolve) => setTimeout(resolve, 2200))
    await settle()
    expect(dialog()).toBeNull()
    expect(card(page).querySelector('[data-testid="device-name"]')?.textContent).toBe('Test phone')
    // A code that was taken is not withdrawn.
    expect(server.requests.some((r) => r.method === 'DELETE' && r.path.startsWith('/api/app-pairing/'))).toBe(false)
  })

  it('says in the dialog when the operator switched pairing or the app off, without a code', async () => {
    const { server } = smallWorld()
    server.settings.public_url = 'https://tasks.example.com'
    server.settings.app_pairing_allowed = false
    const page = await mount(server, '/settings/connections')
    await click(card(page).querySelector('[data-testid="devices-connect"]'))
    await settle()
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe('The operator turned off connecting new devices.')
    expect(dialog()!.querySelector('[data-testid="devices-qr"]')).toBeNull()
    expect(dialog()!.querySelector('[data-testid="devices-address"]')).toBeNull()
    await click(button(dialog()!, 'Close'))

    server.settings.app_enabled = false
    await click(card(page).querySelector('[data-testid="devices-connect"]'))
    await settle()
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe('The operator turned the iPhone app off.')
    expect(server.pairings.size).toBe(0)
  })
})
