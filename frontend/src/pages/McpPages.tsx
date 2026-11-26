/**
 * The pages of the AI tools (MCP, shared module mcp 1.1.0), both only for a signed-in browser:
 *
 * - `/oauth/authorize`: "Programm verbinden", where the account agrees that a program (an AI tool that speaks MCP)
 *   works with its tasks; the module's `ConsentPage` with the level, the spaces and then back to the program.
 * - `/mcp/requests/:id`: one call a key's tool set to "ask" waits for, with everything it would do, "Erlauben" and
 *   "Ablehnen" (the module's `RequestPage`).
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'

import { Logo } from '../components/Logo'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import { moment } from '../lib/time'
import { mcpRequest, useMcpWords } from '../lib/mcp'
import { ConsentPage, RequestPage } from '../vendor/nexmcp'

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="nt-safe nt-scroll flex min-h-dvh flex-col overflow-y-auto">
      <header className="flex items-center justify-between px-5 py-4">
        <Logo withWordmark />
        <ThemeSwitcher />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[6vh] pb-10">{children}</main>
    </div>
  )
}

export function McpConsentPage() {
  const { t, i18n } = useTranslation()
  const words = useMcpWords()
  return (
    <Frame>
      <ConsentPage request={mcpRequest} areaWord={t('mcp.areas')} words={words} language={i18n.language} />
    </Frame>
  )
}

export function McpRequestPage() {
  const { i18n } = useTranslation()
  const { id = '' } = useParams()
  const words = useMcpWords()
  return (
    <Frame>
      <div className="w-full max-w-[640px]">
        <RequestPage request={mcpRequest} id={id} words={words} language={i18n.language} when={(iso) => moment(iso, i18n.language)} />
      </div>
    </Frame>
  )
}
