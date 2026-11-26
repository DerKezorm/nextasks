# Anbindung des Kontenmoduls (`nexkonten`) an nextasks

Stand 25.11.2026, Zweig `konten`. Backend und Oberfläche angebunden (Abschnitt 0). Maßgeblich sind der Entwurf in nexlore
(`Development/nexapps/Baupläne/Entwurf Konten, Einrichtung und Anmeldung.md`) und die Schnittstelle des Moduls
(`bauplaene/konten/SCHNITTSTELLE.md`, Zweig `konten`, Fassung 0.1.0, dazu `oidc` 1.1.0). Wo dieser Plan von beiden
abweicht oder etwas offen lässt, steht es unter „Passt das Modul?“ und „Offene Fragen“.

Grundsatz: **Für niemanden, der nextasks 0.8.0 benutzt, fällt ein Weg hinein weg.** Der Test „Bestand“ beweist das
(Abschnitt 10). Die Reibung in nextasks: **Einladungen führen in Bereiche, auch für Menschen, die schon ein Konto
haben**, eine Adresse dient heute nur den Mitteilungen, und es gibt einen Weg, den der Entwurf nicht kennt: **der
Betreiber setzt ein Passwort selbst** (Konten › „Neues Passwort“). Der Entwurf sagt, nextasks habe gar keinen Weg
zurück; das stimmt nicht ganz.

## 0. Stand

### Durchgang „Einstellungen“ (26.11.2026, Zweig `einst-desktop`)

Nach dem Bauplan in nexlore `Development/nexapps/Baupläne/Bauplan Einstellungen.md` (E1 bis E31). Module aus
`bauplaene-stand` bzw. `bauplaene-einst` (je `tools/sync.py copy`, `check` grün): **ui 1.1.0, konten 1.1.0, oidc 1.2.0,
post 1.1.0, log 1.0.0, sicherung 1.0.1, schluessel 1.0.0** (Stand `bauplaene-stand` `86a0cce`, jede Vorlagen-Kopie mit
ihrer Kopfzeile und den Änderungen der Vorlagen seit `bef0132`; `things`/`thingsDative` = Aufgaben/Aufgaben). Fragen: `einst-fragen/nextasks.md` (1 bis 17; Nacharbeit nach E33, E35 und der gemeinsamen Runde eingetragen).

| Bereich | woher jetzt | was gewandert ist (alt → neu) |
|---|---|---|
| Gerüst | `SettingsLayout`, `SettingsNav`, `SettingsPage` (ui) in `pages/SettingsPage.tsx`, Titel und Zeilen aus `areaText` | eigene `SettingsNav`/`SettingsJump` → Liste unter `/settings` auf dem Handy; Reihenfolge Mein Konto: Profil, Sicherheit, Darstellung, **Benachrichtigungen vor Verbindungen**; alte Pfade (`/account?tab=…`, `/about`, `/settings?tab=…&sub=…`) leiten weiter um |
| Profil | `PAGES.profile` (konten), `UnconfirmedEmailBox`, `SignOutCard` | Karte „Zeitzone“ → Auswahl in der Profilkarte unter Sprache (E14); „Als App installieren“ → Verbindungen; eigene Abmelden-Karte → Modul; neu `POST /api/me/email/prove`, `email_needs_proof` (E23: Bestandsadressen beim ersten Start von 1.1.0 bewiesen, `konten_wanderung.run(first_110)`) |
| Sicherheit | `PAGES.security` | jede Rückfrage nach dem eigenen Passwort heißt „Passwort“; das Fenster „Passwort ändern“ nur mit dem Wortlaut des Moduls (E33) |
| Darstellung | `pages/settings/AppearanceArea.tsx`: `AppearanceCard` (konten), „Seitenleiste“, „Bereiche“, „Tastenkürzel“ | Hell/Dunkel am Konto (`accounts.theme`, `PUT /api/me/theme`, einmal `POST /api/me/theme/adopt` mit dem Wert des Browsers); Augen-Knöpfe → `CheckboxRow`; Filter bearbeiten als `sm` „Bearbeiten“ |
| Benachrichtigungen | `NotifyWays` (ui) zuerst, dann app-eigen „Was kommt wohin“ (E18) | Kästen Mail und Browser → `NotifyWays`; iPhone und iPad mit Verweis auf Verbindungen |
| Verbindungen | „Geräte“ (Kit, `ConfirmDialog`), `components/InstallCard.tsx` (E28: immer da), `ApiKeysCard` (schluessel) | `ApiTokens.tsx`, `KeysWait.tsx` fallen weg; keine Karte „KI-Werkzeuge (MCP)“ (nextasks hat keinen MCP-Zugang, E27) |
| Allgemein | `ServerCards.tsx`: „Grenzen“ (`Field action`), „Funktionen für alle Konten“, `InterfacesCard` (schluessel), „Sprachen“ (`Chip`) | „Dateien“ → Grenzen; „iPhone-App und Einladungen“ → Schnittstellen (App, Koppeln) und Funktionen (Einladungen); Karte „API-Token“ → Schnittstellen; Proxy-Hinweis fällt weg (Bereit fürs Internet?); keine Karte Web Push (Frage 12) |
| Anmeldung | `SignInArea.tsx`: `SignInPage` (konten) + `SignInProviders` (oidc) | `SignInCards.tsx` und Kopplungs-Zweige (nexsuite) fallen weg; neue Wege `GET/PUT /api/server/sign-in`, `GET /api/server/sign-in/readiness` (`routers/server_signin.py`); `PUT /api/settings` bleibt |
| Mail | `MailCard` (post) unter `/api/server/mail` (`routers/server_mail.py`) | `services/mailer.py` fällt weg: Kontomails und Testmail über `post_store.send_letter` (`outbox.deliver_now`); Berichte und Ereignisse als Briefe der App (`channels.mail_letter`, `body_html` im Rahmen, E26) über die eine Outbox von post (`queue`, Schlüssel `notify:<konto>:<key>`, Zustand je Weg über `after_attempt`, E33); `notify_outbox` nur noch für Push, wartende Mail-Zeilen ziehen beim Start um (`move_waiting_mail`); Outbox mit `key`, `waiting`, `on_commit`, `recipient`, `after_attempt`, `outbox_runner` |
| Speicher und Sicherung | Modul sicherung: `services/backup_hooks.py` (Format unverändert), `StorageArea.tsx` | eigene `BackupsCard` → Karten „Speicher“ und „Sicherung“; neu Uhrzeit (`backup_time`, 03:00), „Jeden Monat“; alte Wege `/api/backups/*` mit `x-nextasks-password` über `legacy_router`; Start: `configure`, `tidy_at_start`, `warn_at_start`, `apply_pending`, `report_failed_restore` |
| Konten | Kontenliste (konten, `capsOf`), `WhatYouSeeCard`, `AllKeysCard` (schluessel) | Löschen mit 30 Tagen Zurückholen (`accounts.deleted_at`, `POST /api/accounts/{id}/restore`, Hausputz `manage.purge_due` stündlich); mehrere Betreiber; `Account.shut` sperrt gelöschte wie gesperrte an jeder Tür; gelöschte behalten 30 Tage ihre Mitgliedschaften und Zuweisungen, unsichtbar (`spaces.member_ids`, `services/gone.py`; `/api/app/1` gibt ihre Mitgliederzeile als „gone“ und ihre Aufgaben ohne sie, `/api/v1` lässt sie aus, nicht neu zuweisbar, keine Mitteilungen; Ändern einer Aufgabe behält die Zuweisung, Zurückholen zeigt sie wieder; E33, E35); Tabelle „API-Token aller Konten“ → Modul |
| Log | Modul log (`services/logs.py` = Konfiguration, `routers/logs.py` = `nexlog.api.router`), `LogCard` | Format, Datei, Schlüssel `log_mode`/`log_mode_until` unverändert; geschwärzt jetzt auch `ntd_`, `nxm_` |
| Über | `AboutPage` (ui) | eigene Seite mit Wortmarke → Logo als Bild |

Schlüssel: `services/schluessel_store.py` über `api_tokens` (Vorsilbe `ntk_`, Hash, Stufe, Bereiche unverändert),
Schalter `api_tokens_allowed`, `app_enabled`, `app_pairing_allowed`; Wege `/api/connections/*`; `/api/v1` prüft weiter
selbst; `/api/api-tokens`, `/api/admin/api-tokens` bleiben in alter Form und laufen über `keys.make/revoke/block` (E33).
Ein Konto, das den zweiten Faktor schuldet, listet und legt Schlüssel an (`/api/connections/keys` in
`SETUP_ONLY_PATHS`), sie öffnen nichts bis zum Faktor (E33). Home Assistant, iPhone-App, nexmail und nexnotes
merken nichts (Test `test_settings_pass.py`).

Gesperrt und gelöscht (E38): `KontenStore.on_shut_out`/`on_back`; `channels.ready` gibt einem gesperrten oder gelöschten
Konto keinen Weg (kein Push, keine Mail; Abos und Adresse bleiben), nextasks hat keine eigenen Abgleiche im Hintergrund;
Vertragsadapter `push_ready`. Mail-Fuß: „Diese Mails abbestellen“ führt auf die fragende Seite `/unsubscribe/<token>`
(`unsubscribe_page`), `List-Unsubscribe` bleibt die Adresse mit einem Klick.

Zeiten von Log und Sicherung in der Zone des Kontos (E14, E40: `when`/`clock` an `LogCard`, `when` an `StorageArea`).

Umwege: keine; ruff nimmt alle vendor-Module samt Vertragstests aus. sicherung aus `bauplaene-stand` `b0d3618`. Vorbestehend rot war
e2e Test 34: jetzt grün (Fläche über ihren h1, Karte über `data-card`).

Verweise (E39, E46): Texte, README und `docs/api.md` nennen die Orte der Einstellungen von heute, mit „›“ und der
Gruppe zuerst („Mein Konto › Verbindungen › API-Schlüssel“, „Server › Allgemein › Schnittstellen“, „Server ›
Anmeldung“, „Mein Konto › Darstellung › Seitenleiste“, „Mein Konto › Profil › Sprache“); „Einstellungen ›“ nur auf der
Seite zum Abbestellen und im README vor der Gruppe. In „Was ist neu“ zeigen nur die Wegweiser („where“) auf den Ort
von heute, der Text älterer Fassungen bleibt wie veröffentlicht (E49). Test `i18n/places.test.ts` (Pfeile, Kommas und
ein Ort ohne Gruppe sind rot; Fingerabdruck des Texts jeder veröffentlichten Fassung, gleich dem Zweig `konten`). Die toten Bereichstexte `settings.areas.*`
sind weg.

Gemeinsame Runde (26.11.2026, `bauplaene-stand` `86a0cce`): alle sieben Module neu gezogen, Vorlage
`e2e/nexoidc.spec.ts` mit Kopfzeile 1.2.0. E45: neue Konten haben `theme=system` (`add_account` schreibt `new.theme`,
der OIDC-`create_account` ebenso); die Seite schickt `adopt` nur den Wert, den der Browser wirklich hielt, roh oder
leer (`lib/theme.ts` `storedRaw`, Test `lib/theme.test.ts`). Angeglichen an nexnotes (E39): „iPhone oder iPad
verbinden“ mit Symbol Smartphone, Feld „Größte Datei je Anhang (MB)“. E48: „Funktionen für alle Konten“ mit „Was jedes
Konto auf diesem Server nutzen darf.“; Sprachen nennen die eingebauten (Deutsch und Englisch) und haben „Sprache
hochladen“ am Feld „Sprachcode“ und „Vorlage herunterladen“; „Über › Gebaut mit“ hat keine Zwischenüberschrift (Inter
steht in der Liste wie bei nexnotes). „Verwalten“ in Konten bleibt `sm`, wie konten ihn liefert. Danach konten aus `bauplaene-stand` `1ce1a8f` (E49):
`/api/auth/me` trägt `passkeys_can_add` (`passkeys.can_add`, dieselben Eingaben wie beim Hinzufügen), der Kasten
„Passkeys“ zeigt `PasskeyAddition` des Moduls (Knopf, sonst für den Betreiber der Ort „Server › Anmeldung“, für ein
Mitglied der Satz ohne Ort); Vorlage `nexkonten.cards.test.tsx` übernommen; Tests `test_konten.py` und
`settings.test.tsx` „the box Passkeys“ (Mutationen rot). Läufe danach: pytest 1522 grün, 3 übersprungen; vitest 1160
grün; ruff, lint, build sauber.

Läufe nach der gemeinsamen Runde (26.11.2026, `einst-werkzeug/reihe.sh nextasks ende`): ruff sauber; pytest 1520 grün, 3 übersprungen (Gründe der App: kein git, kein eigener Scanner, keine Links unter Windows); `npm run lint`
sauber; vitest 1153 grün, 0 rot; `npm run build` sauber. Playwright `npm run e2e`: 33, 34, 35 grün. Mutationsproben
(Rückgabecode): neues Konto über einen Anbieter mit `system`, roher Browserwert (`storedRaw`), Symbol Smartphone,
Satz der Funktionen, Feld der Grenzen, Orte mit Pfeil und ohne Gruppe; Schwärzen von `ntd_` (nexlog), Zähler nach dem Wiederherstellen, Zurückholen eines gelöschten Kontos,
Schlüssel bei geschuldetem Faktor (`SETUP_ONLY_PATHS`), gelöschte Mitglieder auf den Geräten (`changes.page`),
Zustand des Mail-Wegs (`after_attempt`), versteckte Zuweisung behalten (`gone.kept`) und nicht zeigen (`gone.shown`), kein Weg für ein gesperrtes Konto
(`channels.ready`), Fuß-Link auf die fragende Seite (`unsubscribe_page`), Zeiten in der Zone des Kontos (Log, Sicherung).

### Auf den Modulen 1.0.0 (25.11.2026)


**Auf den eingefrorenen Modulen konten 1.0.0, ui 1.0.0, post 1.0.0, oidc 1.1.2** (25.11.2026): „Passwort vergessen“
und jeder andere Link, der sofort geht (Bestätigung nach einer Einladung, Reset-Link des Betreibers, neue Adresse),
kommt bei einem Fehler nie in die Outbox (`send_now(..., keep=False)`; nach einer Einladung bleibt die Adresse wartend,
„Link nochmal schicken“ schickt neu). Einladungen in einen Bereich gehen jetzt über post mit `space`, an ein
bestehendes Konto mit `member=True` („Mit dem Knopf trittst du mit deinem Konto bei“); nextasks' eigener Brief von
0.8.0 ist weg. Mail „Neue Anmeldung“ mit Knopf zur Seite Sicherheit (`/settings/security`) und der Uhrzeit in der
Zeitzone der Person (`accounts.timezone`, sonst die des Servers), nie mit einer Netzadresse. Adapter:
`forgot_through_route`, `picture_status` (beide über die echten Routen), `new_sign_in_letter`; vitest-Vorlage mit dem
Abschnitt „Helpers“.


**Nachgezogen auf konten 0.3.10, ui 0.1.2, oidc 1.1.1, post 0.1.2** (25.11.2026): Anmeldung über `login.sign_in`
(der eigene Zweig „nur der Konto-Topf wartet“ ist weg, das Modul antwortet selbst 401); „5 frei“ heißt genau 5 (App-Tests
angepasst, `emailaddr.SENDS_PER_HOUR` = 5); **Adresse entfernen nur mit Passwort** (`DELETE /api/me/email` nimmt
`password`, ohne Passwort frische Anmeldung beim Anbieter; ersetzt „Entfernen geht immer“); **Profilbilder für alle
angemeldeten Konten** (`avatars.may_see`, Web und `/api/app/1`; Namen bleiben bei der Regel gemeinsamer Bereiche);
`accounts.password_changed_at` (Bestand leer) mit „Zuletzt geändert am“ unter Sicherheit; abgelaufene Einladungen bleiben
in `GET /api/invites` mit `expired`, bis sie zurückgenommen sind; „Passwort vergessen“ schickt sofort, eine gescheiterte
Mail kommt nicht in die Outbox (der Link verfällt); Fehler tragen `account_code` neben der alten Kennung, das Web liest
sie über `accountErrorKeyOf`; Einladen mit `inviteRole: false`. Bereichseinladungen bleiben bei nextasks' eigener Mail:
der Brief `invite_space` von post sagt „Mit dem Knopf legst du dein Konto an“, eine Bereichseinladung geht aber auch an
Leute mit Konto (sie treten angemeldet bei).

Backend und Oberfläche laufen auf **konten 0.3.9, oidc 1.1.0, post 0.1.1 und dem Bausatz ui 0.1.1** (Zweig `konten`).
Die Abschnitte 1 bis 13 unten sind die Bestandsaufnahme vor dem Umbau (sie stimmt), die Modulfassungen darin sind
veraltet; Abschnitt 6 beschreibt den Plan der Oberfläche, gebaut ist sie wie in der Tabelle „Oberfläche“ hier.

| Teil | Wo | Was |
|---|---|---|
| Store | `services/konten_store.py` | `KontenStore` über `accounts`, `invites`, `auth_sessions`, `app_devices` (Art `device`, uid `device-<id>`), `api_tokens`, `password_resets`, `former_names`, `passkeys`, `setup_claims`, `failed_unknown`; alte Fehlerkennungen über `OLD_CODES` (`name_taken`, `invalid_account_name`, `invalid_email`) |
| Adresse | `accounts.email_confirmed` (Text, per Link **bewiesen**, wie 0.8.0) und neu `accounts.email_counted` (Text, **zählt** ohne Link) | zählt = Adresse gleich einer der beiden; im Bestand ist `email_counted` leer, es zählen genau die bestätigten Adressen. Wartende Adresse bleibt in `email_pending*` (Links `nxm_…` von 0.8.0 gelten weiter) |
| Wanderung | `db.init_db` + `services/konten_wanderung.py` | nur ergänzend: neue Spalten (Sicherung davor), neue Tabellen, `uid` für alte Sitzungen, eindeutiger Index `lower(name)` nach dem Zählen, Index `lower(email)` nicht eindeutig. 0.8.0 läuft auf dem Ergebnis weiter (Rückweg) |
| Post | `services/post_store.py`, `services/kontenpost.py`, Tabelle `mail_outbox` | Hinweise (neue Anmeldung, Benutzername, Adresse geändert, Faktor zurückgesetzt) über den Postausgang, Arbeiter in der Minutenrunde (`post_store.run_due`); Links, auf die jemand wartet (Bestätigung, neues Passwort, Passwort vergessen) sofort, bei Fehler Postausgang bzw. 502. `notify_outbox` bleibt für nextasks' Berichte |
| Routen | `routers/auth.py`, `routers/accounts.py` (neu, Betreiber), `routers/invites.py`, `routers/notifications.py` (Adresse), `routers/totp.py`, `routers/passkeys.py` (neu), `routers/oidc.py` | Feldnamen von 0.8.0 bleiben; `PUT /api/accounts/{id}/password` antwortet 410 `use_reset_link` |
| Notfall | `python -m app.emergency reset-link <Benutzername oder E-Mail> [--days 1\|7\|30]` | Link auf der Konsole, `origin = server` |
| Nothammer | `NEXTASKS_SECOND_FACTOR_OFF` | `second_factor_off` in `/api/auth/me` |

Eigene Entscheidungen beim Bau: Bremse der Anmeldung über die beiden Töpfe des Moduls; wartet nur der Topf des
Kontos (bzw. der Eingabe), antwortet die Anmeldung wie die Sperre `wrong_credentials` (401) statt 429, damit der Test
„Bestand“ unverändert grün bleibt; der volle Topf des Absenders antwortet 429. Einladungen in einen Bereich gehen mit
nextasks' eigener Mail (sie nennt den Bereich), die des Betreibers über post. `DELETE /api/me/email` braucht kein
Passwort („Entfernen geht immer“). Gelöschte Konten: Name in `former_names` ohne Konto, für immer reserviert.

### Oberfläche (Frontend)

Aussehen aus dem Bausatz `frontend/src/vendor/nexui` mit nextasks' Petrol (`--nexui-*` in `styles/index.css`, hell und
dunkel, auch die Avatar-Farben); jeder Knopf der Kontoseiten über `components/AccountButton.tsx` (Art und Symbol aus
`BUTTONS`). Wortlaute `account.*` und `mail.*` kommen mit den Modulen (`i18n/index.ts`), Fehler über `accountErrorKey`
mit den alten Kennungen (`lib/errors.ts`, `OLD_ACCOUNT_CODES`).

| Bildschirm | Wo | Was |
|---|---|---|
| Einrichten, Anmelden, Passwort vergessen, Neues Passwort, Einladung, Adresse bestätigen | `pages/AuthPages.tsx` (`/setup`, `/login`, `/forgot`, `/reset/<token>`, `/invite/<token>`, `/confirm-email/<token>`) | Felder und Reihenfolge nach `SCREENS`; Anmelden mit „Benutzername oder E-Mail“, „Angemeldet bleiben“, „Passwort vergessen?“, Passkey, Anbieter; Code-Schritt mit Code oder Passkey; Einladung in einen Bereich und die des Betreibers mit einem Formular (`NewAccountForm`), angemeldet „Beitreten als …“ wie in 0.8.0 |
| Sitzung abgelaufen | `components/SessionDialog.tsx`, `state/auth.tsx` | neu: endet die Sitzung auf einer offenen Seite, bleibt die Seite stehen, der Dialog fragt nach `sessionExpiredParts`; danach startet die Sync-Maschine neu und schickt, was wartete (`state/sync.tsx`, `session`) |
| Mein Konto › Profil, Sicherheit | `pages/settings/AccountTab.tsx`, `SecurityBoxes.tsx`, `accountPages.ts` | Teile aus `PAGES`, danach nextasks' eigene (`APP_PAGES`: Zeitzone, Installieren, Abmelden; Anbieter); ein „Speichern“ für Anzeigename, Benutzername, E-Mail mit einer Passwort-Rückfrage (ohne Passwort `account.confirmFresh`) |
| Benachrichtigungen › Mail | `components/Notifications.tsx` | zeigt die Adresse und ihren Zustand, ändern im Profil |
| Server › Konten | `pages/settings/AccountsTab.tsx`, `accountList.ts` | Liste nach `ACCOUNT_LIST`, Fenster „Verwalten“ nach `MANAGE_DIALOG` (`APP_CAPS`: alles außer `restore`), Einladen nach `INVITE_DIALOG` ohne Rolle, `OPEN_INVITES`; darunter „API-Tokens aller Konten“ |
| Mitglieder eines Bereichs | `components/MembersDialog.tsx` | Einladung per Mail mit freiem Anzeigenamen |
| Server › Mail, Anmeldung | `pages/settings/ServerCards.tsx` (`MailCard`), `SignInCards.tsx` | Mailserver nach `MAIL_FIELDS`; Schalter „Zweiten Faktor für alle verlangen“ mit dem Hinweis des Moduls und „Passkeys erlaubt“ |

Tests: `nexkonten.test.ts`, `nexpost.test.ts`, `nexui.vendored.test.ts` (Vorlagen der Module, ausgefüllt gegen den
Testserver `test/fakeServer.ts`), `pages/accountPages.test.tsx` (Sitzung abgelaufen, Passwort vergessen). Playwright
(`frontend/e2e`, zentral auszuführen): Einrichtungscode mit 16 Zeichen, „Username or email“, Verknüpfen im Dialog.

Profilbild ohne Foto: überall (Seitenleiste, Personen, Profil, Kontenliste) der Buchstabe und Farbton aus
`avatarPlaceholder` des Moduls, Sättigung, Helligkeit und Schrift aus `--nexui-avatar-*` (`components/Avatar.tsx`
`placeholder`); vorher hing die Farbe in nextasks am Benutzernamen und wechselte mit ihm.

### Home Assistant

`nextasks-homeassistant`, Zweig `konten` (`b168ceb`, nicht gepusht, kein Release): Ein Eintrag heißt jetzt
`<adresse>::id:<konto-id>::<bereiche>` (aus `id` in `/api/v1/me`). Ein Eintrag von 0.1.0 (`<adresse>::<name>::…`)
übernimmt die ID beim nächsten Start über sein noch gültiges Token, auch nach einem Umbenennen; Geräte und Entitäten
hängen an der `entry_id` und bleiben. „Token erneuern“ erkennt das Konto an der ID, neu Hinzufügen findet auch einen
noch nicht gestarteten Eintrag von 0.1.0. Ein Server ohne `id` behält die Benennung nach Namen. Reihenfolge beim
Aufspielen: erst nextasks mit `id`, dann die Integration (Release, in die laufende Home-Assistant-Installation kopieren), Umbenennen
danach.

### Läufe (25.11.2026, Ende)

Backend `pytest -q -n 2`: 1381 bestanden, 4 übersprungen (darin Vertrag nexkonten 223 + 2 übersprungen, nexoidc 112,
nexpost 25, Bestand 51); `ruff` sauber; `sync.py check` für konten 0.3.9, oidc 1.1.0, post 0.1.1, ui 0.1.1 ok.
Frontend `vitest --maxWorkers=2`: 1043 bestanden (ein erster Lauf unter Last hatte drei Zeitfehler in
`web.test.tsx` „own filters“, allein und im zweiten vollen Lauf grün); `npm run build` und `npm run lint` sauber.
Home Assistant (WSL): 52 bestanden, ruff, `ruff format`, `mypy --strict` sauber.

### Offen

- Sichtprüfung im Browser, Playwright, Probe auf einer Kopie der Live-Datenbank.

## 1. Bestand heute (0.8.0)

### Datenmodell

| Tabelle | Was zum Konto gehört |
|---|---|
| `accounts` | `id` (Integer), `name` (String 64, `unique`, **immer klein**, Muster `^[a-z0-9][a-z0-9._-]{1,63}$` = Regeln des Moduls), `display_name` (80, leer: der Name wird gezeigt), `role` (`operator`/`member`), `sign_in` (`password`/`oidc`), `password_hash`, `email`, `email_source` (`provider`, `own` oder leer), `email_confirmed` (**die Adresse, deren Link geöffnet wurde**; die Adresse gilt, solange beide gleich sind), `email_pending`/`email_pending_hash`/`email_pending_until` (wartende Adresse, 24 h), `language`, `browser_language`, `timezone`, `failed_logins`/`locked_until` (10 Fehlversuche, 15 Minuten), `blocked_at`, `totp_*`, `avatar`/`avatar_at`/`avatar_hash`, `preferences`, `device_key` (neu gezogen bei neuem Passwort und Sperre) |
| `invites` | `token_hash`, `space_id` (**leer: nur in nextasks; sonst in einen Bereich**), `email`, `created_by`, `expires_at` (Betreiber: 1, 7 oder 30 Tage; Bereich: 7). Gültig nur, solange der Einladende den Bereich noch verwaltet |
| `spaces`, `members` | Bereiche; „Privat“ je Konto (`private`, `owner_id`); Mitgliedschaft `(space_id, account_id, role)` |
| `auth_sessions`, `app_devices` (`ntd_…`), `app_pairings`, `api_tokens` (`ntk_…`), `oidc_links`, `webpush_subscriptions`, `notices`, `notify_sent`, `comments` (`author_id`, `mentions` als IDs), `task_events`, `completions` | alle an der ID |
| — | **keine** Tabelle für Links „neues Passwort“ |

Gelöschte Konten verschwinden (Zeile weg, Name wird frei).

### Dienste und Router

| Ort | Was |
|---|---|
| `routers/auth.py` | `GET/POST /api/setup` (`name`, `password`, `language`, `code`), `POST /api/auth/login` (`name` ≤ 64, `password`; Bremsen je Absender und Name, eigene für bekannte Browser), `/api/auth/me`, `PUT /api/me/profile` (`display_name`, `timezone`), `PUT /api/me/language`, `GET /api/people?name=…` (Anzeigenamen zu Benutzernamen), Betreiber `/api/accounts`, Sperren, Rolle, Löschen, **`PUT /api/accounts/{id}/password`** (`password`, `current_password`: der Betreiber setzt ein neues Passwort, alle Sitzungen enden) |
| `services/accounts.py` | `by_name`, `check_name`, `authenticate` (Blindhash, Sperre je Konto, bekannter Browser ausgenommen, gesperrt sagt `account_blocked` erst nach richtigem Passwort), Einladungen, `redeem` (Beitritt zum Bereich, `cursor.WRITE_LOCK`, Mitteilung „beigetreten“, `cursor.touched_everybody()` nach dem Commit) |
| `routers/invites.py` | Betreiber `POST /api/invites` (`days`, `email`, `send`, `language`), Verwalter `POST /api/spaces/{id}/invites` (Web, nur mit Mail), `GET /api/invites/{secret}`, `POST /api/invites/{secret}/accept` (**angemeldetes Konto tritt bei**), `GET/POST /api/invite/{token}` (neues Konto: `name`, `password`), `/api/invite/{token}/join` |
| `routers/app1.py` | iPhone-Vertrag `/api/app/1`: `/me` (`account.id`, `name` = Anzeigename oder Name, `username`), `POST/GET/DELETE /spaces/{id}/invites` (Verwalter, ohne Mail), Mitglieder, Koppeln |
| `routers/notifications.py`, `services/emailaddr.py` | Adresse **unter Benachrichtigungen**: `PUT /api/me/email` (`address`, **ohne Passwort**; nur mit Mailserver), `POST /api/me/email/resend`, `DELETE /api/me/email/pending`, `DELETE /api/me/email`, `POST /api/email/confirm` (`token`, Präfix `nxm_`). Zwei Konten können dieselbe Adresse nicht **bestätigen**; unbestätigt geht es |
| `routers/v1.py` | `/api/v1/me` (`name`, `display_name`, **keine `id`**), `/api/v1/spaces/{id}/members` (`id`, `name`, `display_name`, `role`; liest nexmail) |
| `routers/oidc.py`, `services/oidc_store.py`, `vendor/nexoidc` 1.0.14 | Anbieter; Adresse vom Anbieter unbestätigt (`email_source = provider`) |

### iPhone-App (nextasks-ios, im App Store)

Kein Anmeldeformular: Koppeln per QR-Code, kurzem Code oder `POST /api/app/1/devices`. Die Verbindung hängt an
`accountID` (`ServerAPI.swift:51, 141`, `Library.swift:114, 330`, `SharedServers.swift:20`); `accountName` ist der
Anzeigename und wird bei jedem `/me` aufgefrischt (`ServerSync.swift:147`). Mitglieder und Personen nach ID.

### Tests

`cd backend && .venv/Scripts/python.exe -m pytest` (kein pytest-xdist). Konten: `test_accounts.py`,
`test_hardening_auth.py`, `test_haertung.py`, `test_profile.py`, `test_notifications.py`, `test_spaces_members.py`,
`test_people_privacy.py`, `test_visibility.py`, `test_oidc_app.py`, `test_app_devices.py`, Vertrag `tests/nexoidc/`,
`test_app1_contract.py`. Frontend `cd frontend && npx vitest run --maxWorkers=2`.

## 2. Wo der Benutzername mehr ist als Anzeige

**bricht** = ein Umbenennen machte etwas kaputt; **lösen** = vor dem Ändern-Knopf anfassen; **harmlos** = Anzeige,
Protokoll, Momentaufnahme.

| Stelle | Rolle des Namens | Bewertung |
|---|---|---|
| **nextasks-homeassistant** `config_flow.py:60-73, 141` | `unique_id` des Eintrags = `<adresse>::<name>::<bereiche>`; beim Erneuern des Tokens wird geprüft, ob er mit `<adresse>::<name>::` beginnt | **bricht**: Nach dem Umbenennen bricht „Token erneuern“ mit `wrong_account` ab; neu hinzufügen legt einen zweiten Eintrag an (Entitäten doppelt). Lösung: `/api/v1/me` bekommt `id` (nur ergänzend), die Integration wechselt auf die ID und nimmt alte Einträge mit Namen an. Erst Server, dann Integration, dann Ändern-Knopf |
| `routers/v1.py:373, 412` `/api/v1/me` und `/members` `name` → **nexmail** (`services/nextasksansicht.py:171, 348`, `display_name or name`, Personen nach `id`), **nexdeck** (`adapters/nextasks.py:140, 334`), **nexnotes** (`services/nextasks.py:332`) | Antwortfeld, Anzeige | harmlos: alle nehmen den Anzeigenamen zuerst und ordnen über die ID zu |
| `routers/app1.py:298` `account.username` | Anzeige in der App | harmlos; die App hängt an `accountID` |
| `components/CommentsSection.tsx:144`, `lib/comments.ts:49-89` | Kommentartext enthält `@<gezeigter Name>`; wer gemeint ist, steht als ID in `mentions` | harmlos: Bei Konten ohne Anzeigenamen ist der gezeigte Name der Benutzername; nach dem Umbenennen bleibt `@alt` im alten Text als normaler Text stehen (keine Hervorhebung mehr), die Mitteilung ging schon raus |
| `routers/auth.py:411-424` `GET /api/people?name=` | Anzeigename **zu einem Benutzernamen** | harmlos: kein Aufrufer im Web gefunden; ein alter Aufrufer bekäme nach dem Umbenennen nichts zurück. Beim Umbau prüfen, ob es weg kann |
| `routers/oidc.py:425` `Notice.actor = operator.name` | Momentaufnahme „vom Betreiber X getrennt“ | harmlos |
| `routers/auth.py:276-281` Bremse `login:<ip>|<name>`, `login-dev:<cookie>|<name>` | Zähler im Arbeitsspeicher | harmlos (Umbenennen setzt nur den Zähler zurück); mit dem Modul zählt die Bremse am Konto (`attempt_key`) |
| `routers/totp.py:82` `provisioning_uri(name)`, `AccountTab.tsx:417` Dateiname der Wiederherstellungscodes | Beschriftung | harmlos |
| `routers/invites.py:53` `by: by.name`, `routers/apitokens.py:147` `account: owner.name` | Anzeige für den Betreiber | harmlos |
| `deps.py:134`, `logs.set_actor`, alle `name=%s` im Log | Protokoll | harmlos |
| Sitzungen, Geräte, API-Tokens, OIDC-Verknüpfung, Mitgliedschaften, Zuständige, Reihum, Kommentare, Verlauf, Erledigungen, Push, Mitteilungen, Sicherungen | alle an der ID | harmlos |

Ergebnis: **Eine Stelle bricht**, außerhalb von nextasks (Home Assistant). In nextasks selbst hängt nichts am Namen.

## 3. Zuordnung nextasks ↔ Modul

| Modul | nextasks |
|---|---|
| `id` (`int`) | `accounts.id` |
| `username` | `accounts.name` |
| `display_name` | `accounts.display_name` |
| `email` | `accounts.email` |
| `email_confirmed` | `email != '' and lower(email) == lower(email_confirmed)` (so wie heute `emailaddr.confirmed`) |
| `email_source` | `provider`, wenn `email_source == 'provider'`, sonst `""` (heute `own` oder leer) |
| `pending_email` | `email_pending`, solange `email_pending_until` in der Zukunft liegt |
| `has_password` | `sign_in == 'password' and password_hash != ''` |
| `blocked` | `blocked_at IS NOT NULL` |
| `operator` | `role == 'operator'` |
| `picture` | `avatar` leer → `""`, sonst neu `avatar_source or "own"` |
| `language` | `accounts.language` (leer: `browser_language`, dann Browser) |
| `Invite` | `invites`; `rights` = Zeile mit `space_id`; neu `display_name` |
| `EmailChange` | die drei `email_pending*`-Spalten am Konto (`id` = Konto-ID) |
| `Reset` | neue Tabelle `password_resets` |

Store `services/konten_store.py` (neu). Besonderheiten:

- `add_account(new)`: legt das Konto an; mit `new.invite.rights.space_id` tritt es dem Bereich bei wie heute
  `accounts.redeem` (unter `cursor.WRITE_LOCK`, Mitteilung an den Bereich). `cursor.touched_everybody()` muss **nach**
  dem Commit laufen: der Store merkt es sich und ruft es in `commit()` (das Modul kennt keinen Haken danach).
- `set_email(confirmed=True)` schreibt `email_confirmed = address`, `email_source = 'own'`; `confirmed=False` nur bei
  Adressen vom Anbieter (`email_confirmed` bleibt leer).
- `start_email_change` schreibt die drei Spalten; der Token hat künftig kein `nxm_`-Präfix mehr, der Hash bleibt
  SHA-256 des ganzen Tokens, offene Links der Vorfassung gelten also weiter. Die Route nimmt beide Formen.
- `set_password` hasht, setzt `sign_in = 'password'`, hebt die Sperre auf (`device_key` wird wie heute neu gezogen);
  `end_sessions` = `security.end_all_sessions` (Sitzungen **und** gekoppelte iPhones, neuer `device_key`; wie heute
  beim Passwort vom Betreiber).
- `check_password(None, …)` mit `accounts._dummy_hash`.

`nexoidc` 1.1.0 im selben Zug: `clean_name`/`name_taken` aus dem Modul, `create_account(…, display_name, picture)`
(heute bleibt der Anzeigename eines Kontos vom Anbieter leer), `provider_picture` über `services/avatars.py`.

## 4. Wanderung (nur ergänzend)

nextasks hat keine Schemaschritte: `init_db` legt fehlende Tabellen an, ergänzt fehlende Spalten mit der Vorgabe des
Modells (`_add_missing_columns`, Sicherung davor) und legt fehlende Indizes an (`table_index.create(checkfirst=True)`,
**ohne Prüfung**).

| Neu | Typ, Vorgabe | Bedeutung |
|---|---|---|
| Tabelle `password_resets` | `account_id`, `token_hash` (eindeutig), `created_by` (nullable), `created_at`, `expires_at` | Links für ein neues Passwort; leer im Bestand |
| `invites.display_name` | String(80), Vorgabe `''` | Anzeigename, den der Einladende vorgibt |
| `accounts.avatar_source` | String(16), Vorgabe `''` | vorhandene Bilder gelten als eigene |
| Index `uq_accounts_name_lower` auf `lower(name)` | eindeutig | **nicht** als Modell-Index (der würde ungeprüft angelegt und bei einem Doppel den Start abbrechen), sondern in einem eigenen Schritt nach `GROUP BY lower(name) HAVING count(*) > 1`. Namen sind heute immer klein, ein Doppel ist nicht zu erwarten |
| Index auf `lower(email)` | **nicht** eindeutig | doppelte unbestätigte Adressen gibt es (Test „Bestand“: `carla`/`dora`) |

Rückweg auf 0.8.0 eine Fassung lang: 0.8.0 kennt die neuen Spalten und die Tabelle nicht und lässt sie liegen (es legt
nur Fehlendes an); Konten, Bereiche und Links der neuen Fassung bleiben benutzbar, Links „neues Passwort“ verfallen.

## 5. Routen

**Feldnamen bleiben** (`name`, `password`, `address`, `token`, `display_name`, `code`). Antworten bekommen nur Felder
dazu.

| Route | Heute | Künftig |
|---|---|---|
| `POST /api/setup` | `name`, `password`, `language`, `code` | dazu `display_name` (fehlt er, nimmt die Route `name`), `email` → `nexkonten.setup`; Code über `nexkonten.setup_code` (gleiche Variable) |
| `POST /api/auth/login` | `name` ≤ 64 | `name` ≤ **254**, Inhalt „Benutzername oder E-Mail“. Wie in nexpaper: `nexkonten.resolve_login` statt `by_name`, die eigene Sperre je Konto, die Bremsen und die Ausnahme bekannter Browser bleiben (Schlüssel künftig `account:<id>` statt Name) |
| neu `POST /api/auth/forgot`, `GET/POST /api/reset/{token}` | – | „Passwort vergessen“ per Mail, `nexkonten.forgot` im Hintergrund (`notify`-Muster), 1 Stunde |
| neu `POST /api/accounts/{id}/reset-link` | – | Betreiber, eigenes Passwort → `reset_link`; mit Mail an eine bestätigte Adresse, sonst einmal angezeigt; 24 Stunden |
| `PUT /api/accounts/{id}/password` | Betreiber setzt das Passwort | **fällt weg** laut Entwurf („der Betreiber setzt nie selbst ein Passwort“). Eine Fassung lang `410 use_reset_link`, damit Skripte es merken (offene Frage 2) |
| `PUT /api/me/email` | `address`, ohne Passwort, nur mit Mailserver | `address`, dazu `password` (das Modul verlangt es für Konten mit Passwort); ohne Mailserver gilt die Adresse sofort |
| `POST /api/me/email/resend` | | bleibt: ruft `change_email` mit der wartenden Adresse noch einmal (das Modul hat kein „nochmal schicken“) |
| `DELETE /api/me/email/pending`, `DELETE /api/me/email`, `POST /api/email/confirm` | | `withdraw_email_change`, `change_email("")`, `confirm_email` |
| neu `PUT /api/me/username` | – | `name`, `password` → `change_username` (erst nach Home Assistant, Abschnitt 2) |
| `POST /api/invites` (Betreiber) | `days`, `email`, `send`, `language` | dazu `display_name`; `days` bleibt (offene Frage 3) |
| `POST /api/spaces/{id}/invites` (Web), `POST /api/app/1/spaces/{id}/invites` (iPhone) | Verwalter, Adresse frei bzw. ohne | **nicht** über `invite_values`: Eine Einladung in einen Bereich darf an die Adresse eines bestehenden Kontos gehen (sie tritt dann angemeldet bei). Vertrag `/api/app/1` unverändert |
| `GET /api/invite/{token}` | `space`, `by`, `min_password`, `signed_in_as` | dazu `display_name`, `name` (Vorschlag), `email` aus `invite_form` |
| `POST /api/invite/{token}` | `name`, `password` | dazu `display_name`, `email`. Fehlt `display_name` (Anfrage von 0.8.0), nimmt die Route den Namen; der Test „Bestand“ prüft das |
| `POST /api/invites/{secret}/accept`, `/api/invite/{token}/join` | angemeldetes Konto tritt bei | bleibt App-Sache (das Modul kennt keinen Beitritt) |
| `GET /api/v1/me` | `name`, `display_name`, … | dazu `id` (für Home Assistant) |
| `GET /api/auth/me`, `GET /api/accounts` | `name`, `display_name`, `email` | dazu `email_confirmed`, `email_pending`, `email_duplicate` (Betreiber) |
| neu `PUT /api/accounts/{id}/username`, `/display-name`, `DELETE /api/accounts/{id}/email` | – | Betreiber, eigenes Passwort |

## 6. Oberfläche

Vorgabe: optisch so wenig wie möglich ändern; was sich ändert, überall gleich, Vorbild nexnotes. nextasks hat seit
0.4.x die Bausteine von nexnotes (`AuthFrame`, `Field` mit `label`/`hint`, `Primary`, `Problem`, `Input`, `Select`,
`CopyLink`, Dialoge mit Rückfrage, `Done`-Zeile). Kein neuer Baustein.

| Bildschirm | Heute | Künftig | Sichtbar anders |
|---|---|---|---|
| **Anmelden** (`AuthPages.tsx` `LoginPage`) | „Anmeldename“, „Passwort“, Anbieter | „Benutzername oder E-Mail“, „Passwort“, **„Passwort vergessen?“**, Anbieter | Beschriftung, neuer Link, Fehlertext `account.wrong` |
| **Einrichtung** (`SetupPage`) | Einrichtungscode, Anmeldename, Passwort | Einrichtungscode, Anzeigename, Benutzername (folgt dem Anzeigenamen), E-Mail, Passwort, Passwort wiederholen, Sprache | vier Felder mehr |
| **Einladung** (`InvitePage`) | Satz mit Bereich und Einladendem, „Anmeldename“ (mit Regel), Passwort, Anbieter; angemeldet: „Beitreten als …“ | Anzeigename, Benutzername (Vorschlag), E-Mail (aus der Einladung), Passwort, Passwort wiederholen, „oder“, Anbieter; angemeldet unverändert | drei Felder mehr |
| **Passwort vergessen**, **Neues Passwort** | gibt es nicht | zwei neue Seiten im `AuthFrame` nach `SCREENS.forgot`/`reset` | neu |
| **Profil** (Einstellungen › Mein Konto) | Bild, Anzeigename, Zeile „Anmeldename“, Zeitzone, Sprache, Passwort ändern | Bild, Anzeigename, **Benutzername** (änderbar mit Passwortabfrage), **E-Mail** (aus den Benachrichtigungen hierher, mit „wartet auf Bestätigung“ und Zurücknehmen), Sprache, Zeitzone, Rolle klein | Benutzername änderbar, E-Mail im Profil; die Karte „Mail“ in den Benachrichtigungen verweist auf das Profil |
| **Konten** (Server › Konten) | Zeile: Anzeigename, `@name`; Menü: Sperren, Rolle, **Neues Passwort**, Löschen | Zeile: Anzeigename, klein „Benutzername · E-Mail“, Hinweis bei doppelter Adresse; Menü: **Link für ein neues Passwort** statt „Neues Passwort“, Anzeigename/Benutzername ändern, Adresse entfernen | Betreiber setzt kein Passwort mehr selbst |
| **Person einladen** (Betreiber) | Gültig für, Mailadresse, Senden | dazu Anzeigename | ein Feld mehr |
| **Mitglieder** (`MembersDialog.tsx`, Bereich) | Mailadresse, Link | dazu Anzeigename (frei) | ein Feld mehr |

Wortlaute: Namensraum `account` aus `vendor/nexkonten` in `de.json`/`en.json`. Alte Schlüssel `auth.name`
(„Anmeldename“), `auth.invite.name`, `auth.invite.nameHint` fallen weg (`used.test.ts` hält das sauber). Vor dem
Festschreiben wird jede geänderte Ansicht gezeigt und abgenommen. iPhone-App: keine Änderung nötig.

## 7. Passwort vergessen: beide Wege neu

- **Selbst per Mail**: Feld „Benutzername oder E-Mail“, Link eine Stunde an eine bestätigte, eindeutige Adresse;
  alle Sitzungen und gekoppelten iPhones enden (wie heute beim Passwort vom Betreiber).
- **Betreiber-Link** statt „Neues Passwort“: mit Mailserver und bestätigter Adresse per Mail, sonst einmal angezeigt,
  24 Stunden. Für Konten nur über den Anbieter nur bei eingeschalteter Passwort-Anmeldung.

## 8. Einrichtungscode

Gibt es schon (`NEXTASKS_SETUP_TOKEN`, Code im Log); er wandert ins Modul, Wortlaut und Variable bleiben. Ein
Einspielen einer Sicherung vor der Einrichtung gibt es nicht.

## 9. Einladungen

Zwei Arten bleiben: in nextasks (Betreiber) und in einen Bereich (Verwalter, Web mit Mail, iPhone ohne). Neue Konten
entstehen über `nexkonten.accept_invite`; der Beitritt eines angemeldeten Kontos bleibt App-Sache. Offene Einladungen
von 0.8.0 gelten weiter und nehmen die Anfrage von 0.8.0 an (nur `name` und `password`).

## 10. Test „Bestand“

`backend/tests/test_bestand.py` mit `backend/tests/bestand/bestand-0.8.0.sql.gz`, gebaut von 0.8.0 selbst mit
`tests/bestand/build.py` (erfundene Konten in `bestand-0.8.0.json`). Start:

    cd backend && .venv/Scripts/python.exe -m pytest tests/test_bestand.py -q

Konten: `betreiber` (bestätigte Adresse, zweiter Faktor, Verwalter des Bereichs „Familie“), `anna` (bestätigt,
API-Token, gekoppeltes iPhone, per Link angemeldet beigetreten), `ben` (neues Konto über eine Einladung in „Familie“,
deren Adresse), `carla`/`dora` (eine Adresse, unbestätigt bzw. bestätigt), `emil` (keine Adresse, wartende Adresse,
offene Sitzung), `fritz` (nur Anbieter), `greta` (Passwort und Anbieter), `hans` (gesperrt), `jonas` (Passwort vom
Betreiber gesetzt), `ida` (gelöscht); offene Einladungen: in nextasks mit und ohne Adresse, in „Familie“ mit und ohne
Adresse, eine für den Beitritt angemeldet. Geprüft (47 Fälle): Start ergänzt nur, Adressen und Bestätigung bleiben,
Mitglieder bleiben, Anmelden mit Name in jeder Schreibweise, zweiter Faktor und Wiederherstellungscode, Anbieter,
Sitzung, iPhone (`/api/app/1/me` mit `username`), API-Token, Mitgliederliste für nexmail, alle offenen Einladungen mit
der Anfrage von 0.8.0 (in den Bereich), Beitritt angemeldet, wartende Adresse per Link, Passwort vom Betreiber,
Sperre nach zehn Fehlversuchen je Konto, „Anmeldung mit Passwort aus“, gesperrt und gelöscht bleiben draußen,
geteilte und unbestätigte Adressen öffnen nie ein Konto.

`xfail(strict=True)` (werden mit der Anbindung grün): Anmelden mit eindeutiger bestätigter Adresse; „Passwort
vergessen“ schickt einen Link.

Gegen Mutationen geprüft (alle zwölf Rückgabecode 1): Name mit Groß/Klein; Start
löscht Einladungen, Sitzungen, Anbieterverknüpfungen, Geräte, einfache Mitgliedschaften, wartende Links; Start
bestätigt alle Adressen; keine Sperre; Einladung verlangt Anzeigenamen; Einladung in einen Bereich macht kein Mitglied;
Anmelden mit Adresse eingebaut, Marker vergessen.

Vor dem Aufspielen dieselbe Probe auf einer **Kopie** der Live-Datenbank.

## 11. Risiken

1. **Home Assistant** verliert nach einem Umbenennen das Erneuern des Tokens (Abschnitt 2). Reihenfolge: `id` in
   `/api/v1/me`, neue Integration, dann Ändern-Knopf.
2. **Einladungen an bestehende Konten**: `invite_values` lehnt eine Adresse ab, die schon ein Konto hat. Für
   Bereichseinladungen darf die App es nicht benutzen, sonst kann man keinen Bekannten mehr in einen Bereich holen.
3. **„Neues Passwort“ vom Betreiber fällt weg**: Wer heute so hilft (ohne Mailserver der einzige Weg), bekommt einen
   Link zum Weitergeben. Skripte gegen `PUT /api/accounts/{id}/password` brechen (offene Frage 2).
4. **Adresse ändern verlangt künftig das Passwort** (Modul). Sichtbar im Web.
5. **Adresse ohne Link bestätigt**: Das Modul setzt die Adresse der Einladung und jede Adresse ohne Mailserver als
   bestätigt; nextasks schickt Mitteilungen nur an bestätigte Adressen. Eine vom Betreiber vertippte Adresse bekäme
   dann Aufgabentitel und Wochenberichte. Bei Bereichseinladungen ist die Adresse durch die Mail bewiesen, bei
   kopierten Betreiber-Links nicht.
6. **Eindeutigkeit**: Das Modul prüft `email_taken` gegen alle Adressen in Kraft, auch unbestätigte; heute zählen
   nur bestätigte. `dora` könnte ihre Adresse heute bestätigen, obwohl `carla` sie unbestätigt hat; mit dem Modul
   nicht mehr.
7. **Nach dem Commit**: Beitritt zu einem Bereich weckt wartende Geräte (`touched_everybody`) erst nach dem Commit;
   das Modul hat dafür keinen Haken, der Store muss es in `commit()` tun.

## 12. Passt das Modul?

Ja für Konto, Anmelden und Profil; mit Lücken bei Einladungen und Adressen.

1. **Einladungen sind nur „neues Konto“**. nextasks lädt in Bereiche ein, auch Menschen mit Konto. `invite_values`
   lehnt bestehende Adressen ab, `accept_invite` legt immer ein Konto an. Der Beitritt angemeldeter Konten und die
   Bereichseinladungen bleiben App-Code neben dem Modul. Vorschlag: `invite_values(…, existing_ok=True)` oder eine
   Funktion „Einladung für ein bestehendes Konto einlösen“.
2. **Ein `email_confirmed` für zwei Dinge** (wie nexpaper): „zählt fürs Anmelden“ und „per Link bewiesen, Mails
   dürfen hin“. Das Modul bestätigt ohne Link (Einladung, ohne Mailserver) und ruft für beides
   `set_email(confirmed=True)`.
3. **Passwort beim Adresswechsel Pflicht** (`change_email(password=…)`), nextasks fragt heute nicht. Für nextasks
   eine sichtbare Verschärfung, die der Entwurf nicht ausdrücklich beschließt.
4. **Kein „nochmal schicken“** für den Bestätigungslink.
5. **Kein Haken nach dem Commit** (Bereichsbeitritt, Wartende wecken).
6. **`authenticate` ohne Sperre je Konto** (wie nexpaper); nextasks nimmt `resolve_login` und behält den Rest.
7. **Anzeigename Pflicht** bei Einladung und Einrichtung: alte Anfragen brauchen einen Rückfall in jeder Route.
8. **Entwurf ungenau**: nextasks hat einen Weg zurück (Betreiber setzt das Passwort). Ob er sofort wegfällt, sagt
   der Entwurf indirekt („das direkte Setzen in nexlore fällt weg“), für nextasks nicht.

## 13. Offene Fragen

1. **Einladung an bestehende Konten**: so lassen (Bereichseinladung neben dem Modul) oder das Modul erweitern?
2. **`PUT /api/accounts/{id}/password`**: sofort weg (410) oder eine Fassung lang weiter, mit Hinweis auf den Link?
3. **Einladungsdauer** 1/7/30 Tage für den Betreiber behalten oder überall 7?
4. **Adresse ändern mit Passwort**: einverstanden, dass nextasks künftig fragt?
5. **Mitteilungen an Adressen ohne Link** (Einladung, ohne Mailserver): zulassen oder nur nach Link (eigene Spalte wie in
   nexpaper)?
