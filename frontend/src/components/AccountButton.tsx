/**
 * A button of the account pages: kind, symbol and size come from the module's table (`BUTTONS`, konten 0.3.8;
 * `buttonSize`, konten 1.1.0: `sm` in rows and lists), never from
 * the page, so that the same button looks the same in every nex app. The words are the module's (`t(name)`) or,
 * for a button the app words itself (`signIn`, `done`, ...), the children.
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { BUTTONS, buttonSize, type ButtonName } from '../vendor/nexkonten/konten'
import { Button, type ButtonProps, type IconName } from '../vendor/nexui'

export type AccountButtonProps = Omit<ButtonProps, 'kind' | 'icon' | 'children'> & { name: ButtonName; children?: ReactNode }

export function AccountButton({ name, children, ...rest }: AccountButtonProps) {
  const { t } = useTranslation()
  const spec = BUTTONS[name]
  return (
    <Button size={buttonSize(name)} {...rest} kind={spec.kind} icon={spec.icon as IconName}>
      {children ?? t(name)}
    </Button>
  )
}
