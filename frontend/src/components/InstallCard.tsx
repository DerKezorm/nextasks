/**
 * My account › Connections: "Auf diesem Gerät installieren" (plan "Einstellungen", Verbindungen 2, E6, E28). Always there:
 * what installing gives, then the browser's own install question as a button where it offers one, else a short way per
 * browser (Safari on iPhone and iPad: Share › Add to Home Screen; Firefox cannot install), and in the installed app
 * that it runs as one already. It moved here from the profile.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { install, usePwa } from '../lib/pwa'
import { Button, Buttons, Card } from '../vendor/nexui'

export function InstallCard() {
  const { t } = useTranslation()
  const { installable, ios, standalone } = usePwa()
  const [asked, setAsked] = useState(false)
  const firefox = /Firefox\//.test(navigator.userAgent)
  const way = standalone ? 'installed' : installable ? null : asked ? 'asked' : ios ? 'ios' : firefox ? 'firefox' : 'other'
  return (
    <Card id="install" icon="Download" title={t('pwa.installTitle')} subtitle={t('pwa.text')}>
      {way === null && (
        <Buttons>
          <Button
            kind="primary"
            icon="Download"
            onClick={() => {
              setAsked(true)
              void install()
            }}
            testId="install"
          >
            {t('pwa.install')}
          </Button>
        </Buttons>
      )}
      {way && (
        <p className="m-0 text-sm text-[var(--nexui-text)]" data-testid={`install-${way}`}>
          {t(way === 'ios' ? 'pwa.iosHint' : `pwa.${way}`)}
        </p>
      )}
    </Card>
  )
}
