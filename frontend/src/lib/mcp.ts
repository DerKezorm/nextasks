// The AI tools (MCP, shared module mcp 1.1.0) in nextasks: the client for the module's parts (nextasks' own `api`,
// with its tab header and its errors) and nextasks' words for its tools.
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '../api/client'
import type { McpRequest, McpWords } from '../vendor/nexmcp'

/** The tools of `backend/app/services/mcp.py`, in their order. */
export const MCP_TOOLS = [
  'list_spaces',
  'list_lists',
  'list_tasks',
  'read_task',
  'list_comments',
  'list_members',
  'create_task',
  'update_task',
  'complete_task',
  'add_comment',
  'delete_task',
] as const

export const mcpRequest: McpRequest = <T,>(path: string, init: Parameters<McpRequest>[1] = {}) => api<T>(path, init)

/** The words of nextasks' tools for "Rechte je Werkzeug", the requests and the consent page. */
export function useMcpWords(): McpWords {
  const { t, i18n } = useTranslation()
  return useMemo(
    () => ({ tools: Object.fromEntries(MCP_TOOLS.map((name) => [name, t(`mcp.tools.${name}`)])) }),
    // The words follow the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, i18n.language],
  )
}
