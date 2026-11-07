# Prüfsätze nextasks

Gemeinsame Prüffälle, damit Server (Python), Web (TypeScript) und App (Swift) nachweislich gleich rechnen. Jede Seite
liest die JSON-Dateien in ihren eigenen Tests ein und rechnet jeden Fall nach. Die Referenz ist Python in `referenz/`
(nur Standardbibliothek, für Push zusätzlich `cryptography`); ihre Tests rechnen jede JSON-Datei gegen die Referenz.

```
cd docs/pruefsaetze
python -m pytest referenz
```

Alle Dateien sind UTF-8 ohne BOM, Zeilenende LF. Daten als `YYYY-MM-DD`, Uhrzeiten `HH:MM`.

## wiederholung.json

Prüft `datenmodell.md`, „Wiederholung“. Referenz `referenz/wiederholung.py`.

| Abschnitt | Eintrag | Bedeutung |
|---|---|---|
| `next_due` | `{rule, repeat_from, due_date, on, expect}` | Nächste Fälligkeit nach genau einem Schritt. `due_date` = bisherige Fälligkeit (Basis bei `due`), `on` = Tag des Abhakens (Basis bei `completion`). `expect` = `YYYY-MM-DD` oder `null` (Regel zu Ende: `COUNT=1` oder nächste nach `UNTIL`). |
| `copy_id` | `{original_id, occurrence, expect}` | `id` der erledigten Kopie: UUIDv5, Namensraum = `original_id`, Name = `occurrence` als UTF-8, kleingeschrieben. |
| `count` | `{rule, repeat_from, due_date, on, expect}` | Was am Original nach dem Abhaken steht: `expect` = `{repeat, due_date}` (bei `COUNT=n` steht `COUNT=n-1`, sonst die Regel unverändert) oder `null` (Regel zu Ende, das Original wird selbst erledigt, keine Kopie). |
| `invalid` | `{rule, repeat_from}` | Muss abgelehnt werden (Teilmenge, Schreibweise, Reihenfolge). |
| `valid` | `{rule, repeat_from}` | Muss angenommen werden. |

Jede Regel aus `next_due` und `count` ist ebenfalls gültig. In der Referenz: `validate`, `next_due`, `next_rule`,
`copy_id`, `complete`.

## gleichstand.json

Prüft `datenmodell.md`, „Uhren und Abgleich“. Referenz `referenz/gleichstand.py`.

| Abschnitt | Eintrag | Bedeutung |
|---|---|---|
| `canonical` | `{value, expect}` | `value` (beliebiger JSON-Wert) nach RFC 8785 (JCS) geschrieben ergibt genau den String `expect`. |
| `merge` | `{field, stored_value, stored_clock, incoming_value, incoming_clock, expect}` | Ergebnis der Regel: `take` (übernehmen), `keep` (behalten) oder `same` (gleich, nichts ändert sich). `field` nur zur Lesbarkeit; bei Gruppen (`due`, `place`, `completion`) ist der Wert das Objekt der Gruppenfelder. |

Fallen, die der Satz absichtlich enthält: Schlüssel nach UTF-16-Codeeinheiten sortiert (JCS), Strings aber als
**UTF-8-Bytes** verglichen (JS vergleicht Strings nach UTF-16, Swift nach Graphemen: beides falsch), Zahlen als Text
(`10` < `9`), Escapes vergleichen sich in ihrer geschriebenen Form (`"a\nb"` > `"a b"`), `1.0` ist `1`, `-0` ist `0`,
`null` ist bei gleicher Uhr größer als jeder String, jede Zahl, jede Liste und `false`, aber kleiner als `true` und
jedes Objekt.

## schnelleingabe.json

Prüft `datenmodell.md`, „Schnelleingabe“. Referenz `referenz/schnelleingabe.py`.

`{"cases": [{lang, now, input, expect}]}`. `lang` `de`|`en`, `now` = Ortszeit des Geräts bzw. Browsers als
`YYYY-MM-DDTHH:MM` (fast immer Freitag 2026-11-06T10:00, einige Silvester 2026-12-31T23:30), `input` der getippte
Text. `expect` = `{title, due_date, due_time, tags, priority}` mit `due_date` `YYYY-MM-DD`|null, `due_time`
`HH:MM`|null, `tags` in der Reihenfolge des Auftretens (ohne `#`, wie getippt), `priority` 0–3.

Der Ablauf, wie ihn die Referenz rechnet (Einzelheiten unter „Festlegungen“):

1. Text nach NFC, an Zeichen mit der Unicode-Eigenschaft `White_Space` in Wörter teilen.
2. Wörter von links nach rechts; an jedem Wort in dieser Reihenfolge versuchen: Schlagwort, Priorität, Uhrzeit,
   Datum. Was erkannt wird, verbraucht seine Wörter; sonst bleibt das Wort im Titel.
3. Uhrzeit ohne Datum: heute, wenn sie nicht vor `now` liegt, sonst morgen.
4. Titel = übrige Wörter mit je einem Leerzeichen, unverändert (Groß/klein, Satzzeichen).

## push.json

Prüfwert für den App-Push (`vertrag-block1.md`, „Mitteilungen“; Verfahren wie `nexmail-ios/docs/vertrag-push.md`).
Referenz `referenz/push.py` (`encrypt`, `decrypt`, `public_key`; braucht `cryptography`).

| Feld | Bedeutung |
|---|---|
| `info` | `nextasks-push-v1` (HKDF-SHA256, Salz leer, 32 Bytes) |
| `device_private_key`, `device_public_key` | Test-Geräteschlüssel, derselbe wie in nexmail, **nur für Tests** (X25519 roh, base64) |
| `ephemeral_private_key`, `ephemeral_public_key` | fester ephemerer Schlüssel, nur damit `enc` reproduzierbar ist: die Bytes `0x41`…`0x60` (ASCII `A` bis Gravis) |
| `nonce` | fest, die Bytes `0x61`…`0x6c` (`abcdefghijkl`) |
| `plaintext` | der Klartext als UTF-8 (kompaktes JSON, genau diese Bytes) |
| `enc` | base64 mit Auffüllung von ephemerem öffentlichem Schlüssel (32) + Nonce (12) + Geheimtext mit Tag (16) |

Die App prüft: `enc` mit `device_private_key` entschlüsseln ergibt `plaintext`. Der Server prüft zusätzlich:
`encrypt` mit festem ephemerem Schlüssel und Nonce ergibt genau `enc`. Im Betrieb sind ephemerer Schlüssel und Nonce
immer frisch und zufällig.

## position.json

Prüft `datenmodell.md`, „Reihenfolge (Schlüssel)“. Erzeugt mit der echten Bibliothek `fractional-indexing@3` (3.4.0),
nicht von Hand. Prüfhilfe `referenz/position.py` (`is_valid_key`).

| Abschnitt | Bedeutung |
|---|---|
| `between` | `{a, b, key}`: `generateKeyBetween(a, b)` = `key` (null = offenes Ende) |
| `append_30`, `prepend_30` | 30-mal hinten bzw. vorn anfügen, ab leerer Liste |
| `bisect_lower_20_from` | 20-mal zwischen `a` und dem zuletzt erzeugten Schlüssel |
| `n_keys_between` | `generateNKeysBetween(a, b, n)` |
| `must_fail` | `{a, b, error: true}`: `generateKeyBetween(a, b)` muss scheitern (ungültiger Schlüssel oder gleiche Nachbarn). Jeder Eintrag ist mit der Bibliothek geprüft. |
| `invalid_keys` | `{key, library_throws}`: Schlüssel, die der Server beim `put` ablehnt (`invalid`). `library_throws: false` heißt: die Bibliothek selbst prüft das nicht und rechnet weiter (Fremdzeichen im Bruchteil, siehe Festlegungen); der Server lehnt sie trotzdem ab. |

## Einlesen

Die Dateien liegen im Repo `nextasks-ios` unter `docs/pruefsaetze/`; Server und Web kopieren sie in ihre Tests oder
lesen sie über einen relativen Pfad. Kopien nie von Hand ändern, sondern hier ändern und neu kopieren.

**Python (Server):**

```python
import json, pathlib
data = json.loads(pathlib.Path("wiederholung.json").read_text(encoding="utf-8"))
for c in data["next_due"]:
    got = next_due(c["rule"], c["repeat_from"], c["due_date"], c["on"])
    assert (got.isoformat() if got else None) == c["expect"]
```

Die Referenzmodule dürfen übernommen werden (`referenz/*.py`, je eine Datei ohne Abhängigkeit untereinander).

**TypeScript (Web, vitest):**

```ts
import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync(new URL("./pruefsaetze/gleichstand.json", import.meta.url), "utf8"));
for (const c of data.merge)
  test(c.field, () => expect(merge(c.stored_value, c.stored_clock, c.incoming_value, c.incoming_clock)).toBe(c.expect));
```

Strings für `merge` als UTF-8 vergleichen (`TextEncoder`, dann Byte für Byte), nicht mit `<` (das vergleicht UTF-16).

**Swift (App, XCTest oder Swift Testing):** Dateien als Ressource ins Testziel (`resources: [.copy("pruefsaetze")]`)
oder relativ zu `URL(fileURLWithPath: #filePath)` lesen und mit `JSONDecoder` in `Decodable`-Strukturen holen;
`expect: null` kommt als Optional an. Für `gleichstand.json` braucht es einen eigenen Wertetyp, der `null`, Bool,
ganze Zahl, Kommazahl, String, Liste und Objekt unterscheidet (beim Dekodieren zuerst `Bool`, dann `Int64`, dann
`Double` versuchen); `JSONSerialization` mischt Bool und Zahl in `NSNumber`. Strings für `merge` als `Array(s.utf8)`
vergleichen, nicht mit `<` (das vergleicht Grapheme).

## Festlegungen

Wo Datenmodell oder Vertrag eine Lücke lassen, gilt für die Prüfsätze diese Lesart. So rechnet die Referenz; wer anders
rechnen will, meldet es dem Orchestrator.

**Wiederholung**

1. Schreibweise streng: Teile `KEY=WERT` mit `;`, jeder Teil höchstens einmal, kein leerer Teil, kein `;` am Ende,
   keine Leerzeichen, kein `RRULE:`. Zahlen ohne Vorzeichen und ohne führende Null (`INTERVAL=02`, `BYMONTHDAY=01`
   ungültig); `-1` ist die einzige negative Zahl. `COUNT` und `UNTIL` nie zusammen.
2. Die Pflichtteile (`BYDAY` bei WEEKLY, eins von beiden bei MONTHLY, `BYMONTH` und `BYMONTHDAY` bei YEARLY) gelten
   nur bei `repeat_from: due`. Bei `completion` sind `FREQ=WEEKLY`, `FREQ=MONTHLY`, `FREQ=YEARLY` ohne weitere Teile
   gültig und jedes `BY…` ungültig.
3. YEARLY mit einem Tag, den der Monat nie hat (`BYMONTH=2;BYMONTHDAY=30`, `BYMONTH=4;BYMONTHDAY=31`), ist gültig und
   wird gekappt.
4. Die Kappung bleibt nicht hängen: Basis ist die bisherige `due_date`, der Tag kommt immer neu aus der Regel
   (`BYMONTHDAY=31`: 31.1. → 28.2. → 31.3.; 29.2. jährlich: 2028-02-29 → 2029-02-28 → 2030-02-28 → … → 2032-02-29).
   Bei `completion` kommt der Tag dagegen aus dem Tag des Abhakens.
5. Die `due_date` muss nicht zur Regel passen (Start mitten in der Woche, anderer Monatstag): gesucht ist das kleinste
   passende Datum größer als B in einer erlaubten Woche bzw. einem erlaubten Monat oder Jahr, k = 0 eingeschlossen
   (alle zwei Wochen MO,TH ab einem Mittwoch → Donnerstag derselben Woche).
6. `COUNT=n` ist die Zahl der noch offenen Fälligkeiten einschließlich der aktuellen. `next_due` wertet `COUNT` und
   `UNTIL` selbst aus: `COUNT=1` oder nächste nach `UNTIL` ergibt `null`. `UNTIL` gilt auch bei `completion`.
7. Ein `repeat_from` außer `due` und `completion` macht die Regel ungültig.
8. `complete`: Die Prüfung `occurrence` = `due_date` (`due_changed`) gilt nur mit Wiederholung; ohne Wiederholung
   zählt nur „schon erledigt“ (`already_done`). Mit Wiederholung in dieser Reihenfolge: Kopie schon da →
   `already_done`; Original schon erledigt (Regel war zu Ende) → `already_done`; `occurrence` ≠ `due_date` →
   `due_changed`. `repeat` ohne `due_date` gilt als keine Wiederholung.

**Gleichstand**

9. Die größere Uhr gewinnt immer, auch bei gleichem Wert (`take`: der Wert bleibt, die Uhr steigt). `same` nur bei
   gleicher Uhr und kanonisch gleichem Wert. Kleinere Uhr: immer `keep`.
10. Zahlen nach JCS als IEEE-Double im Format von ECMAScript (`1.0` → `1`, `1e-7` → `1e-7`, `1e21` → `1e+21`).
11. Der Vergleich normalisiert nicht (kein NFC); Texte sind laut Datenmodell schon beim Speichern NFC.

**Schnelleingabe**

12. Wörter gelten nur in ihrer Sprache. DE: `heute`, `morgen`, `übermorgen`, `montag`…`sonntag`, `mo di mi do fr sa so`,
    `uhr`, `um`, `am`. EN: `today`, `tomorrow`, `monday`…`sunday`, `mon tue wed thu fri sat sun`, `at`, `on`. In der
    anderen Sprache sind sie Titel. Folge: Im Deutschen ist `so` bzw. `do` immer ein Wochentag („so schnell wie möglich“
    → Sonntag, Titel „schnell wie möglich“); im Englischen bleibt „Do laundry“ Titel.
13. In beiden Sprachen: `TT.MM.`, `TT.MM.JJJJ`, `H:MM` bzw. `HH:MM` (0–23), `9am`, `9:30pm` (1–12, angehängt,
    groß/klein egal; `12am` = 00:00, `12pm` = 12:00). Nur EN: `MM/DD` ohne Jahr (`3/1/2027` bleibt Titel). `9 am` mit
    Leerzeichen wird nicht erkannt.
14. Tag und Monat ein- oder zweistellig; `TT.MM.` braucht den Schlusspunkt (`24.12` bleibt Titel), das Jahr ist
    vierstellig und hat keinen Schlusspunkt.
15. Datum ohne Jahr: dieses Jahr, wenn der Tag heute oder später ist, sonst nächstes Jahr. Gibt es den Tag in diesem
    Jahr nicht (`31.02.`, `29.02.` vor einem Nicht-Schaltjahr), wird nichts erkannt, das Wort bleibt Titel. Mit Jahr
    gilt das Datum wie geschrieben, auch wenn es vorbei ist.
16. Eine bloße Zahl ist nur im Deutschen eine Uhrzeit, und nur mit `um` davor oder `Uhr` danach (`um 9`, `9 Uhr`,
    `um 9 Uhr`); `Uhr` nach `9:30` wird mitgenommen. Englisch `at 9` bleibt Titel.
17. `um`/`at` direkt vor einer erkannten Uhrzeit und `am`/`on` direkt vor einem erkannten Datum fallen mit weg, sonst
    bleiben sie („Treffen am Ende“).
18. Uhrzeit ohne Datum: heute, wenn sie nicht vor `now` liegt (minutengenau; 10:00 bei `now` 10:00 = heute), sonst
    morgen. Mit Datum gilt das Datum, auch `heute` mit vergangener Uhrzeit.
19. Wochentag: der nächste, nie heute (Freitag am Freitag = in 7 Tagen).
20. Satzzeichen werden nicht abgetrennt: `Heute:`, `Fr.`, `morgen,` bleiben Titel.
21. Schlagwort: `#` plus 1–50 Codepunkte ohne weiteres `#`, Satzzeichen gehören dazu. Doppelte (NFC + `lower()`)
    fallen still aus Titel und Liste, die erste Schreibweise bleibt. Ab dem 21. bleibt das Wort im Titel. `#` allein,
    `C#` und `#a#b` bleiben Titel.
22. Priorität: genau `!`, `!!`, `!!!` als Wort; `!!!!` und `wort!!` bleiben Titel; die erste zählt, weitere bleiben
    Titel.
23. Reihenfolge je Wort: Schlagwort, Priorität, Uhrzeit, Datum. Je Art (außer Schlagworten) zählt die erste
    Fundstelle, spätere bleiben Titel. Der Titel kann leer sein (`""`); was dann geschieht, entscheidet der Aufrufer.
24. Nur ASCII-Ziffern. Getrennt wird an der Unicode-Eigenschaft `White_Space` (Liste `WHITE_SPACE` in der Referenz);
    JS `\s` und Swifts `whitespacesAndNewlines` weichen davon ab, also die Liste nehmen.

**Push**

25. Ephemerer Schlüssel und Nonce sind nur im Prüfwert fest. Verschlüsselt werden genau die Bytes aus `plaintext`
    (Feldreihenfolge wie im Vertrag, kompakt, ohne Leerzeichen).

**Position**

26. Die Bibliothek prüft im Bruchteil keine Zeichen (`a0 `, `a0-`, `a0_`, `a0+`, `a0.5`, `a0é` gehen durch) und
    erkennt vertauschte Nachbarn mit verschiedenem Ganzzahlteil nicht (`generateKeyBetween("a1", "a0")` liefert
    `a0V`). Der Server lehnt Schlüssel mit Zeichen außerhalb Base62 trotzdem ab (`invalid_keys`, `is_valid_key`);
    vertauschte Nachbarn stehen nicht in `must_fail`, weil die Bibliothek dort nicht scheitert.
