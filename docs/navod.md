# DB Mastermind: rychlý návod

Krátký průvodce pro kolegy: jak aplikaci rozběhnout a co v ní najdete. Vše platí pro Windows, macOS i Linux.

## 1. Instalace

- **Windows z Microsoft Store (doporučeno):** [DB Mastermind ve Storu](https://apps.microsoft.com/detail/9p0grd7bz4nf). Podepsané
  Microsoftem, bez varování při spuštění, aktualizuje se přes Store.
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
- **Kopírování výsledku:** TSV (pro Excel), JSON nebo Markdown (dobré pro vložení do AI chatu), volitelně i s SQL.
- **Více výsledků najednou:** když skript vrátí víc výsledků, vpravo v liště jsou *Kopírovat vše* a *Stáhnout vše*
  (Excel s listem pro každý výsledek, ostatní formáty jako ZIP).
- **Výpadek VPN nebo sítě:** když server není dostupný, aplikace to na pozadí sama zkouší znovu a průzkumník tabulek
  se připojí, jakmile server zase odpovídá.
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
- **Nový model od nuly:** na úvodní stránce zvolte *Nový model* a *Přidat první tabulku*. Tabulka se otevře
  v návrháři, kde přidáte sloupce, klíče, další tabulky a vazby. DBML psát nemusíte.
- **Model bez připojení:** model otevřete z úvodní stránky, přes *Soubor → Otevřít model* (⌘O / Ctrl+O), přetažením
  souboru do okna nebo dvojklikem na `.dbml`. Databázi vyberete v liště modelu, až budete chtít porovnání.
- **Diagram do PDF:** *Export → PDF* uloží diagram na jednu stránku, nebo v čitelné velikosti na více listů A4
  (každý list má v rohu číslo řádku a sloupce).
- **Diagramy projektu DeZignu:** v liště modelu přepínáte mezi celým modelem a jeho diagramy. *Nový diagram…*
  založí další, ve stejném výběru diagram přejmenujete nebo odeberete; tabulku do diagramu přidáte hledáním nad
  plátnem a odeberete z její nabídky (v modelu zůstane). Diagram zobrazuje tabulky jako v DeZignu: všechny
  sloupce, jen klíče, jen primární klíče, prvních 10/20, nebo jen názvy, s typy i bez (lišta diagramu);
  jednotlivé sloupce skryjete v nabídce tabulky (*Zobrazené sloupce*). Rámečky (group boxes) přidáte tlačítkem,
  přesunete za titulek, velikost změníte v rohu, přejmenujete a odeberete z jejich nabídky.
- **Aktualizace modelu z databáze:** *Z databáze → Aktualizovat model* doplní do modelu, co v databázi přibylo
  nebo se změnilo; komentáře, domény a rozložení modelu zůstanou.
- **Porovnání s archivovanou verzí:** u modelu z DeZignu nabídne *Porovnat s verzí…* verze uložené v projektu;
  uvidíte změny od té doby a ALTER skript pro databázi modelu. *Archivovat verzi…* uloží aktuální stav projektu
  jako novou verzi, stejně jako v DeZignu (File → Versions); DeZign ji pak vidí mezi svými. Databázi k tomu
  připojovat nemusíte: skript je pro databázi projektu a uložíte ho do souboru (*Uložit skript…*). Tlačítkem
  *Otevřít tuto verzi* si verzi prohlédnete i s diagramy na vlastní záložce; do projektu se z ní nic nezapíše.
- **Porovnání se SQL skriptem:** *Porovnat se souborem…* (u projektu DeZign v nabídce *Porovnat s verzí… → Jiný
  soubor…*) přijme i `.sql`, třeba výpis produkční databáze z pg_dump nebo mysqldump. Uvidíte rozdíly a ALTER skript,
  který databázi ze skriptu dorovná na model.
- **Skripty projektu:** *Skripty projektu…* u modelu z DeZignu upraví SQL, které projekt přidává před a za skript
  CREATE a ALTER (v DeZignu nastavení projektu). Uloží se do projektu a použije se v dalších skriptech.
- **Pohledy:** *Pohledy…* u modelu z DeZignu ukáže SQL pohledů projektu tak, jak ho drží DeZign (`%viewname%`
  zastupuje název pohledu). Úprava se při uložení zapíše do projektu a jde do DDL skriptu.
- **Týmová práce v Gitu:** u složkového projektu (`.dezproj`) uložení změní jen soubory upravených objektů, takže
  dva kolegové, kteří upravují různé tabulky ve svých větvích, je sloučí bez konfliktu.
- **Domény:** *Domény…* u modelu z DeZignu ukáže pojmenované typy projektu. Změna typu domény se propíše do všech
  sloupců, které se jí řídí; nová doména se nabídne v panelu tabulky. Doménu lze přejmenovat (sloupce ji následují)
  a smazat, pokud ji žádný sloupec nepoužívá.
- **Balíčky atributů:** sloupce, které projekt DeZignu vkládá do mnoha tabulek najednou (např. auditní sloupce),
  ukáže prohlížeč objektů ve skupině *Balíčky atributů*. V dialogu tabulky je vloží *Přidat balíček…*; sloupce
  zůstanou s balíčkem propojené jako v DeZignu. Sloupec z balíčku, kterému změníte název nebo definici, se stane
  vlastním sloupcem tabulky.
- **Uložení:** *Uložit* (⌘S) vezme i změny z plátna a dialogů, které ještě nejsou v textu modelu.
- **Hromadné přejmenování:** *Přejmenovat…* u modelu nahradí text nebo regulární výraz v názvech tabulek, sloupců
  nebo obojího (třeba předponu `tbl_` za nic). Než se cokoli změní, ukáže každé přejmenování; název, který by byl
  prázdný nebo už existuje, vynechá. Klíče, indexy, vazby a kontroly názvy následují a do projektu DeZign se uloží
  jako přejmenování (tabulky a sloupce zůstanou tytéž).
- **Diagram z výběru:** vyberte tabulky a v liště nad nimi zvolte *Nový diagram z těchto tabulek*.
- **Porovnání s databází:** přejmenovaný sloupec nebo tabulku pozná a nabídne jako přejmenování (data zůstanou);
  jednotlivé změny lze ze skriptu vynechat. ALTER i CREATE skript dostanou úvodní a závěrečný skript projektu.
- **Skript DROP:** *SQL DDL → Skript DROP…* odstraní vše, co model vytváří (pohledy, tabulky v pořadí, které
  cizí klíče dovolí, a domény).
- **Export do DeZignu:** model vytvořený tady uložíte přes *Uložit jako…* i jako nový projekt DeZign for Databases
  pro kolegy, kteří pracují v DeZignu: jeden soubor `.dez`, nebo složkový projekt `.dezproj` (pro Git, soubor
  na každý objekt). Ověřeno v DeZignu 14.9.3: projekt otevře a uloží beze ztráty.
- **Panel tabulky:** v režimu *Návrh* kliknutím na tabulku otevřete panel, kde upravíte sloupce (název, typ,
  NOT NULL, výchozí hodnotu, komentář, pořadí, doménu), cizí klíče (i název a ON UPDATE), indexy a kontroly
  CHECK. Funguje i u modelu bez připojené databáze; *Zapsat do DBML* přenese změny do textu modelu. Vazbu
  nakreslíte tažením zelené tečky v záhlaví tabulky na jinou tabulku: sloupec klíče se vytvoří sám. Kliknutím na
  čáru vazby otevřete její vlastnosti (kardinalita, ON DELETE/UPDATE, sloupce složeného klíče), dvojklikem na
  tabulku její panel. V panelu je i víceřádkový komentář, poznámky (Notes), řazení (collation) a schéma, do kterého
  tabulka patří. Pravým tlačítkem tabulku zduplikujete nebo smažete; klávesa Delete smaže vybrané tabulky (v panelu
  je jde vrátit). Více tabulek vyberete tažením s klávesou Shift nebo klikáním s Shiftem a v liště nahoře je
  zarovnáte nebo rovnoměrně rozmístíte; tabulky se při přesunu přichytávají k mřížce. ⌘Z / Ctrl+Z vrací i přesuny.
  ⌘C / Ctrl+C zkopíruje vybrané tabulky (i s vazbami mezi nimi), ⌘V / Ctrl+V je vloží jako nové do téhož nebo
  jiného modelu.
  Na plátně modelu se tažením po prázdné ploše vybírají tabulky (jako v DeZignu), kolečkem nebo dvěma prsty se
  posouvá a s klávesou ⌘ (Ctrl) přibližuje; ⌘A / Ctrl+A vybere všechny tabulky, ukazatel vlevo dole vrátí přiblížení na 100 %.
- **Objekty modelu:** vlevo od diagramu je přepínač *Objekty / Text*. Objekty (u projektu z DeZignu výchozí)
  ukazují tabulky, vazby, domény a pohledy s hledáním; kliknutím tabulku najdete v diagramu, dvojklikem otevřete
  její dialog. Text modelu (DBML) je o jedno kliknutí dál pro ty, kdo ho rádi píší. U modelů vytvořených
  v aplikaci jsou v Objektech i výčty (enum) a skupiny tabulek, upravují se v dialozích.
- **Dialogy jako v DeZignu:** dvojklikem na tabulku modelu otevřete její dialog: sloupce v mřížce (název, typ,
  PK, NOT NULL, autoinkrement, výchozí hodnota, doména, komentář; pod mřížkou poznámky a řazení vybraného
  sloupce), indexy a kontroly, cizí klíče, popis a náhled SQL. Dvojklikem na čáru vazby otevřete dialog vazby:
  kardinalita, identifikující vazba, povinný rodič, ON DELETE/UPDATE a náhled čáry. Změny platí až po OK.
- **Kontroly modelu:** počítadlo v liště modelu ukazuje, co stojí za pozornost (tabulky bez klíče, nesoulad typů
  cizího klíče, duplicitní indexy, cizí klíče bez indexu, názvy mimo styl, vazby, které nikdo nedeklaroval,
  názvy delší, než databáze dovolí – PostgreSQL je nad 63 bajtů potichu ořízne).
  Kliknutím přejdete na tabulku; bezpečné opravy jsou na jedno kliknutí.
- **Modely z DeZign for Databases:** *Otevřít model* přijme i soubory `.dez` a složkové projekty `.dezproj`
  (DeZign 4 až 14) včetně rozložení hlavního diagramu. Z modelu pak vygenerujete DDL nebo ALTER skript proti
  živé databázi. *Uložit* zapíše změny zpět do projektu DeZignu (nejdřív je vypíše a ponechá zálohu;
  ověřeno v DeZignu 14.9.3, který takto uložené soubory otevře a uloží beze ztráty), *Uložit jako* vytvoří
  samostatný model `.dbml`.
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
  - složka kanálu v Teams: v kanálu **Soubory → Otevřít v SharePointu → Synchronizovat** (nebo *Přidat zástupce
    do Mých souborů*), na složce zvolte *Vždy uchovávat v tomto zařízení* a vyberte ji jako týmovou složku
    nebo jako znalostní bázi připojení (Znalostní báze → *Změnit…*)
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
