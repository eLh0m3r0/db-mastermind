# DB Mastermind: rychlý návod

Krátký průvodce pro kolegy: jak aplikaci rozběhnout a co v ní najdete. Vše platí pro Windows, macOS i Linux.

## 1. Instalace

- **Windows bez instalace:** stáhněte `DB-Mastermind-…-win-x64-portable.zip` z
  [posledního vydání](https://github.com/eLh0m3r0/db-mastermind/releases/latest), rozbalte ho a spusťte
  `DB Mastermind.exe`. Připojení a nastavení se ukládají do složky `data` vedle aplikace.
- **Windows s instalací:** použijte `…-win-x64-setup.exe` (nepotřebuje správce) nebo pro IT `…-win-x64.msi`.
- **macOS:** stáhněte `.dmg`, nebo použijte Homebrew:
  `brew tap elh0m3r0/db-mastermind https://github.com/eLh0m3r0/db-mastermind && brew install --cask db-mastermind`.
  Aplikace zatím není notarizovaná, takže při prvním spuštění: pravé tlačítko → Otevřít. Další verze se už
  stahují a instalují samy (stejně jako instalátor na Windows).

Zkoušíte aplikaci v pilotu? Viz [pilot.md](pilot.md): co vyzkoušet a jak hlásit chyby.

Jazyk přepnete v **Nastavení → Obecné → Jazyk**. Při prvním spuštění se řídí jazykem systému.

## 2. Připojení k databázi

- **Nové připojení** (vlevo dole): PostgreSQL, SQL Server, Oracle, MySQL, MariaDB, SQLite, DuckDB, ClickHouse, CockroachDB, BigQuery nebo Trino.
  - Do pole nahoře můžete vložit celý connection string a formulář se vyplní sám.
  - U SQL Serveru na Windows zvolte **Ověření Windows** a heslo nezadáváte.
- **Import:** tlačítko *Importovat připojení* vedle *Nové připojení* najde nástroje na počítači (Beekeeper Studio, DBeaver,
  DataGrip, pgAdmin, SSMS, Azure Data Studio, MySQL Workbench, HeidiSQL a další) nebo načte soubor od kolegy. Z Beekeeper
  Studia a DBeaveru převezme i uložená hesla; když heslo chybí, aplikace se na něj při připojení zeptá.
- **Sdílení s kolegy:** pravé tlačítko na připojení → *Sdílet s kolegy (bez hesla)…*. Soubor neobsahuje hesla.
- **Ochrana produkce:** připojení označte jako *Jen pro čtení* nebo jako produkční prostředí. Aplikace se pak ptá před
  každou nebezpečnou operací.

## 3. Prohlížení a filtrování dat

- Dvojklikem na tabulku v levém panelu otevřete data.
- **Filtr** (⌘F / Ctrl+F):
  - skupiny podmínek A/NEBO a přes 25 operátorů (v seznamu, mezi, regex, posledních N dní…)
  - vlastní WHERE
  - filtr popsaný slovy, který sestaví AI
- **Úpravy:** pište přímo do buněk nebo vložte data z Excelu. Nic se neuloží, dokud změny nepotvrdíte tlačítkem *Použít*
  v liště (náhled SQL je k dispozici).
- **Velké hodnoty:** Shift+Enter otevře editor buňky, kde lze JSON formátovat a kontrolovat.
- **Sloupce:** pravým tlačítkem na hlavičku je skryjete, posunete nebo ukotvíte (*Ukotvit sloupce až sem*).
- **Export:** CSV, Excel, JSON, SQL nebo Markdown, a to celé tabulky i celého výsledku dotazu bez omezení počtu řádků.

## 4. SQL editor

- ⌘↵ / Ctrl+Enter spustí příkaz pod kurzorem, ⇧⌘↵ celý skript.
- Našeptávání zná schéma. Po `JOIN` nabídne související tabulky i s celou podmínkou `ON`.
- ⌘I / Ctrl+I: popište dotaz slovy a AI ho napíše. U chyby je tlačítko *Opravit pomocí AI*.
- Výsledky můžete připnout, zobrazit jako graf a vložit do dashboardu.
- **Rozdělené zobrazení:** ⌘\ / Ctrl+\ zobrazí dvě karty vedle sebe, třeba dotaz a tabulku.

## 5. Diagramy a návrh schématu

- **ER diagram:** příkazová paleta (⌘K / Ctrl+K) → *Otevřít ER diagram*.
  - zaměření na tabulku a její sousedy
  - cesta mezi dvěma tabulkami jako hotový JOIN
  - barvy tabulek a poznámky
  - uložené diagramy pro jednotlivé oblasti
- **Návrh změn (*Návrh*):**
  - Tabulky, sloupce, klíče a indexy upravujete přímo v diagramu.
  - *Navrhnout s AI…* navrhne změnu podle popisu.
  - *Zkontrolovat migraci* ukáže SQL skript, kontroly nad daty a rollback. Jednotlivé změny lze vynechat.
- **Modely v DBML:** text a diagram vedle sebe, vizuální úpravy se zapisují zpět do textu. Model porovnáte
  s databází nebo se starší verzí souboru.
- **Porovnání:** schéma dvou databází (dev → prod) s migrací, nebo data dvou tabulek se synchronizačním skriptem.

## 6. AI asistent

- **Nastavení → AI asistent:**
  - vlastní klíč (Anthropic, OpenAI, OpenRouter, Azure, Gemini) nebo lokální Ollama
  - nebo předplatné Claude Code / Codex přes jejich přihlášení
- Asistent (⌘J / Ctrl+J) prozkoumá schéma, spustí dotazy jen pro čtení a před každou změnou se zeptá.
- **Znalostní báze:** složka s Markdown poznámkami o databázi (co znamenají kódy a stavy, jak tabulky souvisí).
  Nastavíte ji v připojení. První verzi může napsat AI.
- **Claude Code, Codex, Cursor…:** v **Nastavení → MCP server** jedním kliknutím přidáte DB Mastermind jako MCP
  server. Agenti pak používají vaše připojení, standardně jen pro čtení.

## 7. Týmová spolupráce

- **Týmová složka** (Nastavení → Obecné):
  - síťový disk, OneDrive nebo Git repozitář s připojeními (bez hesel), uloženými dotazy, diagramy
    a znalostními bázemi
  - změny od kolegů se načtou samy
  - podrobnosti v [team-folder.md](team-folder.md)
- **Spravovaná konfigurace pro IT:** soubor `dbmastermind-managed.json` vedle aplikace. Přidá předdefinovaná
  připojení a pravidla, například vypnutí AI nebo MCP. Viz [managed-config.md](managed-config.md).
- **Zálohy:** pravé tlačítko na připojení → *Zálohovat…* / *Obnovit ze zálohy…*.

## Klávesové zkratky

| Zkratka | Akce |
|---|---|
| ⌘K / Ctrl+K | příkazová paleta |
| ⌘P / Ctrl+P | rychle otevřít tabulku |
| ⌘T / Ctrl+T | nový dotaz |
| ⌘↵ / Ctrl+Enter | spustit příkaz |
| ⌘I / Ctrl+I | napsat SQL pomocí AI |
| ⌘J / Ctrl+J | AI asistent |
| ⌘\ / Ctrl+\ | rozdělené zobrazení |
| Shift+Enter | editor hodnoty buňky |
| ⌘, / Ctrl+, | nastavení |

Chyby a nápady pište do [Issues](https://github.com/eLh0m3r0/db-mastermind/issues).
