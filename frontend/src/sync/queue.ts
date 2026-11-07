/**
 * The queue of own changes not yet confirmed: `/batch` operations and `/files` uploads in the order they were made.
 * It survives a reload (localStorage for the entries, IndexedDB for the files of uploads where the browser has it).
 * An entry leaves only with a `Result`.
 */
import type { Op } from './types'

export interface OpEntry {
  type: 'op'
  op: Op
  /** How often `parent_missing` sent it back. */
  tries?: number
}

export interface UploadEntry {
  type: 'upload'
  op_id: string
  id: string
  reminder_id: string
  name: string
  mime: string
  size: number
}

export type Entry = OpEntry | UploadEntry

export interface KeyValue {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export const browserStorage: KeyValue = {
  get: (key) => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value)
    } catch {
      // Full or forbidden: the queue holds until the tab closes.
    }
  },
  remove: (key) => {
    try {
      localStorage.removeItem(key)
    } catch {
      // nothing to do
    }
  },
}

export function memoryStorage(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, get: (key) => data.get(key) ?? null, set: (key, value) => void data.set(key, value), remove: (key) => void data.delete(key) }
}

/** Where the files of waiting uploads stay. */
export interface BlobStore {
  put(key: string, blob: Blob): Promise<void>
  get(key: string): Promise<Blob | null>
  remove(key: string): Promise<void>
}

export function memoryBlobs(): BlobStore {
  const data = new Map<string, Blob>()
  return {
    put: async (key, blob) => void data.set(key, blob),
    get: async (key) => data.get(key) ?? null,
    remove: async (key) => void data.delete(key),
  }
}

/** IndexedDB when the browser has it, else memory (the file then waits only as long as the tab is open). */
export function browserBlobs(): BlobStore {
  if (typeof indexedDB === 'undefined') return memoryBlobs()
  const fallback = memoryBlobs()
  let db: Promise<IDBDatabase | null> | null = null
  const open = () =>
    (db ??= new Promise((resolve) => {
      try {
        const request = indexedDB.open('nextasks-uploads', 1)
        request.onupgradeneeded = () => request.result.createObjectStore('files')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    }))
  const run = async <T,>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> => {
    const handle = await open()
    if (!handle) return null
    return new Promise((resolve) => {
      try {
        const request = work(handle.transaction('files', mode).objectStore('files'))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return {
    put: async (key, blob) => {
      await fallback.put(key, blob)
      await run('readwrite', (store) => store.put(blob, key))
    },
    get: async (key) => (await fallback.get(key)) ?? ((await run<Blob>('readonly', (store) => store.get(key))) || null),
    remove: async (key) => {
      await fallback.remove(key)
      await run('readwrite', (store) => store.delete(key))
    },
  }
}

export class Queue {
  entries: Entry[] = []

  constructor(
    private readonly storage: KeyValue,
    private readonly key: string,
  ) {
    const saved = storage.get(key)
    if (saved) {
      try {
        const parsed = JSON.parse(saved)
        if (Array.isArray(parsed)) this.entries = parsed
      } catch {
        // A damaged queue is dropped; the server's state stands.
      }
    }
  }

  save(): void {
    if (this.entries.length) this.storage.set(this.key, JSON.stringify(this.entries))
    else this.storage.remove(this.key)
  }

  push(entry: Entry): void {
    this.entries.push(entry)
    this.save()
  }

  remove(opId: string): void {
    this.entries = this.entries.filter((e) => (e.type === 'op' ? e.op.op_id : e.op_id) !== opId)
    this.save()
  }

  ops(): Op[] {
    return this.entries.filter((e): e is OpEntry => e.type === 'op').map((e) => e.op)
  }

  get length(): number {
    return this.entries.length
  }
}

export function entryId(entry: Entry): string {
  return entry.type === 'op' ? entry.op.op_id : entry.op_id
}
