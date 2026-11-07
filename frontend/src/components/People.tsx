/**
 * People as the sync shows them (`people` of `/changes`): picture or round letter, "Former member" for a deleted
 * account. Pictures come from `/people/{id}/avatar` with the web's header, so they are fetched and shown as a blob.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { APP_BASE } from '../sync/transport'
import type { Person } from '../sync/types'
import { letterColors, personColor } from './Avatar'

const pictures = new Map<string, Promise<string | null>>()

function picture(id: number, hash: string): Promise<string | null> {
  const key = `${id}:${hash}`
  let found = pictures.get(key)
  if (!found) {
    found = fetch(`${APP_BASE}/people/${id}/avatar`, { headers: { 'X-Nextasks-Client': 'web' }, credentials: 'same-origin' })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => (blob ? URL.createObjectURL(blob) : null))
      .catch(() => null)
    pictures.set(key, found)
  }
  return found
}

// eslint-disable-next-line react-refresh/only-export-components
export function personName(person: Person | undefined, t: (key: string) => string): string {
  if (!person) return t('people.unknown')
  return person.name ?? t('people.former')
}

export function PersonAvatar({ person, id, className = 'h-6 w-6 text-[11px]', ring = false }: { person: Person | undefined; id: number; className?: string; ring?: boolean }) {
  const { t } = useTranslation()
  const hash = person?.avatar_hash ?? null
  const [url, setUrl] = useState<{ key: string; url: string | null } | null>(null)
  const key = hash ? `${id}:${hash}` : ''
  useEffect(() => {
    if (!hash) return
    let alive = true
    void picture(id, hash).then((found) => alive && setUrl({ key: `${id}:${hash}`, url: found }))
    return () => {
      alive = false
    }
  }, [id, hash])
  const name = personName(person, t)
  const classes = 'grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold ' + (ring ? 'ring-2 ring-ink-850 ' : '') + className
  if (url && url.key === key && url.url) return <img src={url.url} alt="" title={name} className={classes + ' object-cover'} />
  return (
    <span title={name} className={classes} style={letterColors(personColor(name))} aria-hidden>
      {person?.name ? (person.name.trim()[0] ?? '?').toUpperCase() : '?'}
    </span>
  )
}

export function AvatarStack({ ids, people, max = 3 }: { ids: number[]; people: Map<number, Person>; max?: number }) {
  const { t } = useTranslation()
  if (!ids.length) return null
  const names = ids.map((id) => personName(people.get(id), t)).join(', ')
  return (
    <span className="flex -space-x-[7px]" title={names} aria-label={t('reminder.assignedTo', { names })} role="img">
      {ids.slice(0, max).map((id) => (
        <PersonAvatar key={id} id={id} person={people.get(id)} className="h-[22px] w-[22px] text-[11px]" ring />
      ))}
      {ids.length > max && <span className="grid h-[22px] min-w-[22px] place-items-center rounded-full bg-ink-800 px-1 text-[10px] text-mist-400 ring-2 ring-ink-850">+{ids.length - max}</span>}
    </span>
  )
}
