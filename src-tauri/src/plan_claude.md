# Plan WikExp: instrukcja dla Claude Code

> Ten plik jest zarządzany przez WikExp i nadpisywany przy każdym starcie. Nie edytuj go, swoje uwagi dopisuj w osobnym pliku.

W tym folderze leży plan Wiktora: **tablica kanban (pomysły, zadania w realizacji) i kalendarz (zajęcia, wydarzenia, zadania na dni)**. WikExp pokazuje to w panelach „plan” i „kalendarz”. Całość to jeden plik **`plan.json`**. Możesz go swobodnie czytać i edytować: WikExp sprawdza plik co ~2 sekundy i sam pokazuje zmiany, a zapisuje atomowo (plik tymczasowy + zamiana).

Pliki: `plan.json` (dane, edytuj), `validate.mjs` (walidator), `plan.bak-RRRR-MM-DD.json` (dzienne kopie, nie edytuj; można z nich przywrócić stan), `CLAUDE.md` (ten plik).

## Zasady pracy (ważne)
1. **Po każdej edycji uruchom `node validate.mjs`** (w tym folderze) i popraw wszystkie BŁĘDY. Uszkodzony plik WikExp odrzuca (pokazuje czerwony pasek i nic nie zapisuje), więc nic się nie zgubi, ale zmiany nie zadziałają.
2. Zapisuj poprawny JSON z wcięciem 2 spacje. Nie zmieniaj `version`.
3. **Nie zmieniaj istniejących `id`.** Nowe id to dowolny unikalny, krótki napis bez spacji (np. `t-sprawozdanie-1`, `ev-ako-wyklad`). Nie używaj ponownie id usuniętych rzeczy.
4. Daty: `RRRR-MM-DD`. Godziny: `GG:MM` (24 h, z zerem na początku: `09:05`). Dni tygodnia: liczby **0 = poniedziałek … 6 = niedziela**. Kolory: `accent`, `blue`, `green`, `yellow`, `orange`, `red`, `muted` (to nazwy kolorów motywu, nie wartości hex).
5. Zanim usuniesz cokolwiek, sprawdź powiązania (patrz niżej). Wolisz **archiwizować** karty (przenieś obiekt do `board.archive` i usuń z `board.cards` i z `lanes[].cards`), niż je kasować.
6. Bieżącą datę weź z systemu (`date`), nie zgaduj. Użytkownik pisze po polsku, tytuły kart i wydarzeń też pisz po polsku.

## Schemat `plan.json`
```json
{
  "version": 1,
  "board": {
    "lanes": [
      { "id": "l1", "title": "Do zrobienia", "color": "blue", "limit": null, "collapsed": false, "cards": ["t1", "t2"] }
    ],
    "cards": {
      "t1": {
        "id": "t1", "title": "Sprawozdanie z lab 3", "notes": "", "categories": ["c1"],
        "values": { "f1": "wysoki" }, "created": 1793000000000, "done": false,
        "scheduled": { "date": "2026-11-05", "time": null },
        "link": null
      }
    },
    "categories": [ { "id": "c1", "name": "uczelnia", "color": "blue" } ],
    "fields": [
      { "id": "f1", "name": "Priorytet", "type": "select", "options": ["niski", "średni", "wysoki"] },
      { "id": "f2", "name": "Termin", "type": "date", "options": [] }
    ],
    "archive": []
  },
  "calendar": {
    "kinds": [ { "id": "k1", "name": "Wykład", "color": "blue" } ],
    "events": [
      {
        "id": "ev1", "title": "AKO wykład", "kind": "k1", "date": "2026-10-07",
        "allDay": false, "start": "10:15", "end": "11:45", "location": "sala 301", "notes": "",
        "repeat": { "freq": "weekly", "interval": 2, "weekdays": [], "until": "2027-01-31", "count": null, "exceptions": ["2026-11-11"] }
      }
    ]
  }
}
```

### Tablica (`board`)
- `lanes[]`: kolumny w kolejności od lewej. `cards` to **uporządkowana lista id kart** z tej kolumny (od góry). `limit`: `null` albo liczba całkowita > 0 (limit rozpoczętych kart, tylko wizualny).
- `cards{}`: obiekt id → karta. Klucz musi się równać polu `id`. **Każda karta musi leżeć w dokładnie jednej kolumnie** (`lanes[].cards`). Pola: `title` (niepusty), `notes` (dowolny tekst), `categories` (id z `board.categories`), `values` (id pola → wartość; patrz niżej), `created` (ms od 1970; przy nowej karcie użyj `Date.now()`), `done` (ukończone), `scheduled`, `link`.
- `fields[]`: własne pola. Typy: `text` (napis), `number` (liczba), `date` (`RRRR-MM-DD`), `select` (jedna z `options`), `checkbox` (zapisuj `true`; brak klucza = nie). Puste wartości **pomijaj** (nie zapisuj `""` ani `false`).
- `archive[]`: pełne obiekty kart (z `scheduled: null`, `link: null`), poza `cards` i `lanes`.

### Kalendarz (`calendar`)
- `kinds[]`: typy wydarzeń (kolor w kalendarzu). Zawsze co najmniej jeden.
- `events[]`: wydarzenia. `date` = dzień **pierwszego** wystąpienia. `allDay: true` → `start` i `end` ustaw na `null`. Inaczej `start` jest wymagany, `end` może być `null`.
- `repeat`: `null` = jednorazowe. Inaczej:
  - `freq`: `daily` | `weekly` | `monthly` | `yearly`; `interval` ≥ 1 (`2` + `weekly` = co drugi tydzień);
  - `weekdays` (tylko `weekly`): dni, w które wypada, np. `[0, 2]` = pon i śr; **puste = dzień tygodnia z `date`**;
  - koniec: `until` (ostatni dzień, włącznie) **albo** `count` (łączna liczba wystąpień od `date`); oba `null` = bez końca. Dla zajęć semestralnych ustaw `until`;
  - `exceptions`: lista dni, w które to wystąpienie jest odwołane (np. święto). Nie przesuwają licznika `count`;
  - miesięcznie/rocznie: ten sam dzień miesiąca, krótszy miesiąc przycina dzień (31.01 → 28.02).
- Nie ma wyjątków „przesunięte na inną godzinę”: odwołaj wystąpienie w `exceptions` i dodaj osobne jednorazowe wydarzenie.

### Powiązania kart z kalendarzem
- `card.scheduled = { "date": "RRRR-MM-DD", "time": "GG:MM" lub null }`: zadanie na konkretny dzień (pokazuje się w kalendarzu).
- `card.link = { "eventId": "<id wydarzenia>", "date": "RRRR-MM-DD" lub null }`: karta należy do wydarzenia; `date` = konkretne wystąpienie (np. oddać sprawozdanie na labach 12.11), `null` = cała seria (np. materiały do przedmiotu). Karta ma zwykle **albo** `scheduled`, **albo** `link`.
- `link.eventId` musi istnieć w `calendar.events`. Usuwając wydarzenie, ustaw `link: null` w jego kartach. Odwołując jedno wystąpienie (`exceptions`), wyzeruj `link` kart z tą datą.

## Przepisy
- **Nowa karta:** dodaj obiekt do `board.cards` i jej id na koniec `cards` odpowiedniej kolumny.
- **Przenieś kartę do „Zrobione”:** usuń id z `cards` starej kolumny, dopisz do nowej; opcjonalnie `done: true`.
- **Zajęcia co tydzień przez semestr:** jedno wydarzenie z `repeat: { freq: "weekly", interval: 1, weekdays: [], until: "<ostatni dzień semestru>", count: null, exceptions: [] }`. Co 2 tygodnie: `interval: 2`. Tygodnie A/B: dwa wydarzenia z `interval: 2`, drugie z `date` przesuniętą o tydzień.
- **Odwołane zajęcia (święto):** dopisz datę do `repeat.exceptions` tego wydarzenia.
- **Zaplanuj zadanie na piątek:** `scheduled: { "date": "<piątek>", "time": null }`.
- **Rozpisz projekt na zadania:** kilka kart w kolumnie „Do zrobienia”, każda z `scheduled` na kolejne dni i kategorią projektu.
- **Plan tygodnia:** przeczytaj `calendar.events` (rozwiń `repeat` ręcznie dla danego tygodnia) i karty ze `scheduled` w tym tygodniu.

Kolejność kolumn i kart w `plan.json` jest kolejnością widoczną w WikExp. Użytkownik może edytować te same dane w interfejsie w tym samym czasie: jeśli WikExp jest otwarty, rób edycje jednym zapisem pliku (nie w wielu małych krokach).
