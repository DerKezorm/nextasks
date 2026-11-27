/**
 * The pages of connections with other nex apps (shared module verbinden 0.1.9), both only for a signed-in browser
 * (`SignedIn` in `App.tsx`):
 *
 * - `/connect/app`: another nex app (nexmail, nextime …) asks to use the account's tasks; the module's `ConsentPage`
 *   with the account, what each side may, the spaces, "Verbinden erlauben" and "Ablehnen".
 * - `/connect/return`: back from another app's consent page; the module's `ReturnPage` finishes the connection and
 *   goes on to My account › Connections, a refusal with it into the partner's card.
 *
 * Since verbinden 0.1.8 (V48) both pages bring their own frame (`PAGE_FRAME`: the whole height, the card in the middle
 * of the window); nextasks adds none.
 */
import { useTranslation } from 'react-i18next'

import { api } from '../api/client'
import { ConsentPage, ReturnPage, type VerbindenRequest } from '../vendor/nexverbinden'

const request: VerbindenRequest = <T,>(path: string, init: Parameters<VerbindenRequest>[1] = {}) => api<T>(path, init)

export function ConnectConsentPage() {
  const { t, i18n } = useTranslation()
  return <ConsentPage request={request} areaWord={t('mcp.areas')} language={i18n.language} />
}

export function ConnectReturnPage() {
  const { i18n } = useTranslation()
  return <ReturnPage app="nextasks" request={request} language={i18n.language} />
}
