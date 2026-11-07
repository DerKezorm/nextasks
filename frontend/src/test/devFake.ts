/**
 * `npm run dev` with `VITE_FAKE=1`: the fake server in front of the page, with a small invented family and its
 * reminders, so the web can be looked at without a server. Everything stays in the tab; a reload starts afresh.
 */
import { addDays } from '../sync/repeat'
import { FakeServer } from './fakeServer'

function day(offset: number): string {
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return addDays(today, offset)
}

export function seeded(german: boolean): FakeServer {
  const server = new FakeServer()
  server.waitMs = 20_000
  const w = (de: string, en: string) => (german ? de : en)
  const robin = server.addAccount('Robin', { operator: true, language: german ? 'de' : 'en', password: 'robin-robin-1' })
  const alex = server.addAccount('Alex', { language: german ? 'de' : 'en' })
  const sam = server.addAccount('Sam', { language: german ? 'de' : 'en' })
  server.session = robin
  const privateSpace = [...server.rows.values()].find((r) => r.kind === 'space' && r.data.private && server.member(r.id, robin))!.id
  const reminders = [...server.rows.values()].find((r) => r.kind === 'list' && r.data.space_id === privateSpace)!.id
  server.change('list', reminders, { color: 'blue', icon: 'list' })
  const books = server.addList(privateSpace, w('Lesen', 'Reading'), { color: 'purple', icon: 'book' })

  const family = server.addSpace(w('Familie', 'Family'), robin, { color: 'green', icon: 'house' })
  server.join(family, alex, 'manager')
  server.join(family, sam, 'member')
  const shopping = server.addList(family, w('Einkauf', 'Groceries'), { color: 'orange', icon: 'cart' })
  const home = server.addList(family, w('Haushalt', 'Home'), { color: 'teal', icon: 'house' })
  const trip = server.addList(family, w('Urlaub', 'Holiday'), { color: 'pink', icon: 'plane', view: 'columns' })

  const club = server.addSpace(w('Sportverein', 'Sports club'), alex, { color: 'red', icon: 'sport' })
  server.join(club, robin, 'member')
  const games = server.addList(club, w('Spieltage', 'Match days'), { color: 'red', icon: 'trophy' })

  server.addReminder(reminders, w('Zahnarzttermin vereinbaren', 'Book a dentist appointment'), { due_date: day(0), due_time: '09:30', priority: 2, created_by: robin })
  server.addReminder(reminders, w('Steuererklärung abgeben', 'File the tax return'), { due_date: day(-2), flagged: true, created_by: robin, notes: w('Belege liegen im Ordner im Arbeitszimmer.', 'Receipts are in the folder in the study.') })
  server.addReminder(reminders, w('Geburtstagsgeschenk für Kim', 'Birthday present for Kim'), { due_date: day(5), tags: [w('geschenk', 'gift')], created_by: robin })
  server.addReminder(reminders, w('Fahrrad zur Inspektion', 'Bike to the service'), { created_by: robin })
  server.addReminder(books, w('Der Hobbit', 'The Hobbit'), { created_by: robin })
  server.addReminder(books, w('Sapiens', 'Sapiens'), { created_by: robin, completed_at: new Date(Date.now() - 86_400_000).toISOString(), completed_by: robin })

  server.addReminder(shopping, w('Hafermilch', 'Oat milk'), { tags: [w('kühl', 'cold')], created_by: alex })
  server.addReminder(shopping, w('Äpfel', 'Apples'), { created_by: sam })
  server.addReminder(shopping, w('Brot', 'Bread'), { flagged: true, created_by: robin })
  server.addReminder(shopping, w('Kaffee', 'Coffee'), { priority: 1, created_by: alex })

  server.addReminder(home, w('Müll rausbringen', 'Take out the bins'), { due_date: day(0), due_time: '19:00', repeat: 'FREQ=WEEKLY;BYDAY=' + ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date().getDay()], assignees: [robin, sam], created_by: alex })
  const plants = server.addReminder(home, w('Pflanzen gießen', 'Water the plants'), { due_date: day(1), repeat: 'FREQ=DAILY;INTERVAL=3', assignees: [sam], created_by: alex })
  server.addReminder(home, w('Balkon', 'Balcony'), { parent_id: plants, created_by: alex })
  server.addReminder(home, w('Küche', 'Kitchen'), { parent_id: plants, created_by: alex })
  server.addReminder(home, w('Heizung entlüften', 'Bleed the radiators'), { due_date: day(3), assignees: [robin], flagged: true, created_by: alex, location: { name: w('Zuhause', 'Home'), lat: 52.52, lon: 13.4, radius_m: 150, on: 'arrive' } })
  server.addReminder(home, w('Fenster putzen', 'Clean the windows'), { created_by: sam, url: 'https://example.com/fenster' })

  const before = server.addSection(trip, w('Vorher', 'Before'), 'a0')
  const pack = server.addSection(trip, w('Packen', 'Packing'), 'a1')
  const there = server.addSection(trip, w('Vor Ort', 'There'), 'a2')
  server.addReminder(trip, w('Ferienwohnung bestätigen', 'Confirm the flat'), { section_id: before, due_date: day(10), created_by: robin })
  server.addReminder(trip, w('Katzensitter fragen', 'Ask the cat sitter'), { section_id: before, assignees: [alex], created_by: robin })
  server.addReminder(trip, w('Sonnencreme', 'Sun cream'), { section_id: pack, created_by: sam })
  server.addReminder(trip, w('Ladekabel', 'Chargers'), { section_id: pack, created_by: sam })
  server.addReminder(trip, w('Bootstour buchen', 'Book the boat trip'), { section_id: there, tags: [w('ausflug', 'trip')], created_by: alex })

  server.addReminder(games, w('Trikots waschen', 'Wash the shirts'), { due_date: day(2), assignees: [robin], created_by: alex })
  server.addReminder(games, w('Fahrgemeinschaft Samstag', 'Car pool on Saturday'), { due_date: day(1), due_time: '08:00', created_by: alex })
  return server
}

/** Puts the fake in front of `fetch` for the whole page. */
export function installFake(): FakeServer {
  const german = (navigator.language || 'en').toLowerCase().startsWith('de')
  const server = seeded(german)
  const real = window.fetch.bind(window)
  const fake = server.fetcher()
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = new URL(url, window.location.origin).pathname
    return path.startsWith('/api/') ? fake(input, init) : real(input, init)
  }) as typeof fetch
  ;(window as unknown as { nextasksFake: FakeServer }).nextasksFake = server
  return server
}
