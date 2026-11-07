/** note-app.html: the bridge on the page, `window.nextasksNote` for the app (docs/editor-bruecke.md in nextasks-ios). */
import '@milkdown/kit/prose/view/style/prosemirror.css'
import './note-app.css'

import { NoteBridge, VERSION, type Message } from './bridge'

declare global {
  interface Window {
    nextasksNote: NoteBridge
    webkit?: { messageHandlers?: { nextasks?: { postMessage: (message: Message) => void } } }
  }
}

const root = document.getElementById('note')!
const post = (message: Message) => window.webkit?.messageHandlers?.nextasks?.postMessage(message)
window.nextasksNote = new NoteBridge(root, post)
window.addEventListener('error', (event) => post({ type: 'error', message: String(event.message) }))
post({ type: 'ready', version: VERSION })
