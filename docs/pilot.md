# Pilot: DB Mastermind místo Beekeeper Studia

Díky, že to zkoušíte. Cílem je pár týdnů normální práce s databázemi v DB Mastermindu a hlášení všeho, co nefunguje
nebo jde ztěžka. Aplikace je zdarma a open source, bez placené verze.

## 1. Instalace (5 minut)

Stáhněte si [poslední vydání](https://github.com/eLh0m3r0/db-mastermind/releases/latest):

| Systém | Soubor | Poznámka |
|---|---|---|
| Windows | `DB-Mastermind-…-win-x64-setup.exe` | Nepotřebuje správce, aktualizuje se sám. |
| Windows bez instalace | `DB-Mastermind-…-win-x64-portable.zip` | Rozbalit a spustit `DB Mastermind.exe`; data zůstávají ve složce `data`. |
| macOS | `DB-Mastermind-…-mac-arm64.dmg` (Apple Silicon) / `…-mac-x64.dmg` (Intel) | Přetáhnout do Aplikací; aktualizuje se sám. |

**Varování při prvním spuštění** (aplikace zatím nemá placený podpis):
- **Windows:** „Systém Windows ochránil váš počítač“ → *Další informace* → *Přesto spustit*.
- **macOS:** pravé tlačítko na aplikaci → *Otevřít* → *Otevřít*. Při prvním čtení uložených hesel se macOS zeptá na
  klíčenku: zadejte heslo k Macu a zvolte **Vždy povolit**.

## 2. Připojení (2 minuty)

- **Importovat připojení** (úvodní obrazovka nebo dole vlevo): aplikace sama najde Beekeeper Studio, DBeaver, DataGrip,
  pgAdmin, SSMS, Azure Data Studio a další. Z Beekeeper Studia a DBeaveru převezme i uložená hesla.
- **Nové připojení:** do pole nahoře můžete vložit connection string (`postgres://…`, JDBC, ADO.NET) a formulář se
  vyplní sám. Když heslo chybí, aplikace se na něj zeptá při připojení.
- **Doporučení pro pilot:** u produkčních databází zapněte v připojení **Jen pro čtení** a nastavte prostředí
  **Produkce** (barevný pruh, potvrzení před nebezpečnými příkazy).

## 3. Co prosím vyzkoušet

Hlavně to, co běžně děláte v Beekeeperu, a navíc:

1. **Data v tabulce:** filtry (⌘F / Ctrl+F), řazení, úpravy buněk, vkládání a mazání řádků, export do CSV nebo Excelu.
2. **SQL editor:** spuštění příkazu pod kurzorem (⌘↵ / Ctrl+Enter), našeptávání, historie, uložené dotazy.
3. **ER diagram:** příkazová paleta (⌘K / Ctrl+K) → *Otevřít ER diagram*; *Navrhnout* pro změny schématu s náhledem
   migrace.
4. **AI asistent** (volitelné): *Nastavení → AI asistent*. Funguje s API klíčem (Claude, OpenAI, OpenRouter…) nebo
   s předplatným Claude Code / Codex. Co smí AI na kterém připojení, nastavíte v *Nastavení → Oprávnění AI*.
5. **Knowledge base:** poznámky k databázi v Markdownu, které čte AI i kolegové; přes *Změnit…* je můžete mít v Git
   repozitáři projektu nebo v týmové složce.

## 4. Jak nahlásit chybu nebo nápad

- V aplikaci: **Nápověda → Nahlásit problém** (nebo *Nastavení → O aplikaci*). Otevře se formulář na GitHubu
  s předvyplněnou verzí aplikace a systémem.
- **Nikdy do hlášení nevkládejte hesla ani citlivá data.** Stačí popis, kroky a snímek obrazovky (údaje rozmažte).
- Drobnosti a „tohle je otravné“ jsou stejně cenné jako chyby: přesně o ty v pilotu jde.
- Kdo nemá účet na GitHubu, pošle hlášení e-mailem nebo zprávou Václavovi.

## 5. Bezpečnost v kostce

- Hesla jsou uložená šifrovaně (Windows: DPAPI, macOS: klíč v klíčence), nikam se neposílají.
- AI vidí jen to, co jí v *Oprávnění AI* povolíte (vypnuto / jen schéma / čtení dat / čtení i zápis). Každou změnu dat
  navrženou AI potvrzujete v aplikaci a připojení *Jen pro čtení* nezapisuje nikdy.
- Sdílení připojení s kolegy (*Sdílet s kolegy*, týmová složka) nikdy neobsahuje hesla.
