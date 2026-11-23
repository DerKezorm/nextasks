// Own colours as in nexnotes (contract 0.8): the colour field of a list takes `#rrggbb` typed or from the system's
// picker, keeps the last ones on this device, refuses anything else, and the sidebar draws an own colour readably.
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { contrast, readableColor } from '../lib/color'
import { colorOf } from '../lib/look'
import { smallWorld } from '../test/fakeServer'
import { button, click, mount, press, settle, type, unmount } from '../test/harness'

afterEach(unmount)

async function openEdit(page: HTMLElement): Promise<HTMLElement> {
  await click(page.querySelector('[aria-label="More about the list"]'))
  const entry = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((item) => item.textContent?.includes('Name, colour, symbol'))
  await click(entry)
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
  expect(dialog?.textContent).toContain('Edit list')
  return dialog!
}

describe('own colours', () => {
  it('takes a colour typed as #rrggbb, saves it and keeps it among the recent ones', async () => {
    const { server, home } = smallWorld()
    const page = await mount(server, `/lists/${home}`)
    let dialog = await openEdit(page)
    const hex = dialog.querySelector<HTMLInputElement>('[data-testid="color-hex"]')!
    await type(hex, '#1E3A8A')
    await press(hex, 'Enter')
    const own = dialog.querySelector('[data-color="#1e3a8a"]')
    expect(own?.getAttribute('aria-checked')).toBe('true')
    expect(own?.getAttribute('aria-label')).toBe('Own colour #1e3a8a')
    expect(dialog.querySelector('[data-color="orange"]')?.getAttribute('aria-checked')).toBe('false')
    await click(button(dialog, 'Save'))
    await settle()
    expect(server.data('list', home)!.color).toBe('#1e3a8a')

    // Back to a fixed colour: the own one stays at hand on this device.
    dialog = await openEdit(page)
    expect(dialog.querySelector('[data-color="#1e3a8a"]')?.getAttribute('aria-checked')).toBe('true')
    await click(dialog.querySelector('[data-color="teal"]'))
    expect(dialog.querySelector('[data-color="#1e3a8a"]')?.getAttribute('aria-checked')).toBe('false')
    await click(button(dialog, 'Save'))
    await settle()
    expect(server.data('list', home)!.color).toBe('teal')
  })

  it('takes the colour of the system picker when it closes', async () => {
    const { server, home } = smallWorld()
    const page = await mount(server, `/lists/${home}`)
    const dialog = await openEdit(page)
    const picker = dialog.querySelector<HTMLInputElement>('[data-testid="color-picker"]')!
    await act(async () => {
      picker.value = '#ff5a5f'
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(dialog.querySelector('[data-color="#ff5a5f"]')?.getAttribute('aria-checked')).toBe('true')
    expect(dialog.querySelector<HTMLInputElement>('[data-testid="color-hex"]')!.value).toBe('#ff5a5f')
  })

  it('says how to write it and changes nothing when the text is no colour', async () => {
    const { server, home } = smallWorld()
    const page = await mount(server, `/lists/${home}`)
    const dialog = await openEdit(page)
    const hex = dialog.querySelector<HTMLInputElement>('[data-testid="color-hex"]')!
    await type(hex, '#12')
    await press(hex, 'Enter')
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('Enter the colour as #rrggbb, for example #1e3a8a.')
    expect(dialog.querySelector('[data-color="orange"]')?.getAttribute('aria-checked')).toBe('true')
  })

  it('draws an own colour so that it reads on light and dark grounds, the fixed ones as they are', () => {
    expect(colorOf('#7a8890')).toBe('#7a8890')
    const night = colorOf('#0a0a40')
    expect(night).toBe(readableColor('#0a0a40'))
    expect(night).not.toBe('#0a0a40')
    for (const ground of ['#0f1417', '#131a1f', '#172026']) expect(contrast(night, ground)).toBeGreaterThanOrEqual(3)
    expect(colorOf('orange')).toBe('#dd7a2e')
    expect(colorOf('#ABC')).toBe(colorOf('blue'))
  })
})
