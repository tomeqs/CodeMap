# Wtyczki językowe (protokół 1)

CodeMap zna C# sam z siebie. Inne języki dochodzą jako **wtyczki**: osobne programy w dowolnym języku, które czytają kod
i zapisują **surowy graf** w formacie [CodeMap JSON](format.md). Resztę CodeMap robi tak samo jak dla C#: metryki, cykle,
nieużywany kod, warstwy, analizę DI, historię gita, łączenie kilku języków w jedną mapę, raporty i mapę 3D.

Pierwszą wtyczką jest TypeScript / JavaScript ([`analyzers/typescript`](../analyzers/typescript)): Node.js + TypeScript compiler API,
z Expressem (trasy), NestJS i Angularem (role, punkty wejścia, kontener DI) rozpoznawanymi po importach.

## Gdzie CodeMap szuka wtyczek

W tej kolejności (dla jednego `id` wygrywa pierwsza znaleziona):

1. foldery z `CODEMAP_PLUGIN_PATH` (rozdzielone `:` albo `;` na Windows) i z opcji `--plugins <folder>`,
2. `~/.codemap/plugins` (albo `$CODEMAP_HOME/plugins`),
3. `plugins/` obok programu `codemap` (tam trafia wtyczka TypeScript z wydaniami i z `dotnet build`).

Folder jest wtyczką, gdy ma plik `codemap-plugin.json`, albo folderem wtyczek, gdy mają go jego podfoldery.
**Wtyczki nigdy nie są ładowane z analizowanego repozytorium**: wtyczka to program, który się uruchamia.

`codemap --version` wypisuje znalezione języki, czy ich środowisko (np. Node.js) jest dostępne i dlaczego ewentualnie nie jest.

Rozszerzenie VS Code ma wtyczkę TypeScript w sobie i ustawia `CODEMAP_NODE` na Node.js wbudowany w VS Code (Electron jako Node),
chyba że wskazano inny w ustawieniu `codemap.nodePath` albo w zmiennej `CODEMAP_NODE`.

## Manifest `codemap-plugin.json`

```json
{
  "protocol": 1,
  "id": "typescript",
  "idPrefix": "ts:",
  "name": "TypeScript",
  "version": "0.1.0",
  "command": ["node", "--max-old-space-size=8192", "./src/cli.mjs"],
  "runtime": { "name": "node", "minVersion": 18, "envVar": "CODEMAP_NODE", "help": "Zainstaluj Node.js 18+." },
  "inputs": "a package.json, tsconfig.json, .ts or .js file",
  "markers": "package.json, tsconfig.json or .ts files",
  "detect": {
    "markers": ["package.json", "tsconfig.json", "jsconfig.json"],
    "sources": [".ts", ".tsx", ".js"],
    "inputs": ["package.json", "tsconfig.json", "*.ts", "*.js"],
    "ignoreDirs": ["node_modules", "dist", "build"]
  },
  "display": {
    "levels": { "project": ["Package", "Packages"], "namespace": ["Folder", "Folders"], "type": ["File", "Files"], "member": ["Declaration", "Declarations"] },
    "external": "npm packages"
  },
  "unused": { "memberAccessibility": ["private"], "skipTags": ["entrypoint", "test"], "skipParentKinds": ["interface"] }
}
```

| Pole | Znaczenie |
|---|---|
| `protocol` | wersja protokołu; CodeMap odrzuca manifesty z wersją, której nie zna |
| `id` | identyfikator języka (małe litery, cyfry, `-`); `--lang` go używa |
| `idPrefix` | każdy id węzła wtyczki musi się od niego zaczynać (min. 2 znaki + `:`); `project:`, `namespace:`, `package:`, `assembly:` są zarezerwowane dla C# |
| `command` | program i argumenty; argumenty zaczynające się od `./` to pliki wtyczki |
| `runtime` | gdy `command[0]` to `runtime.name`, CodeMap szuka go w zmiennej `envVar`, a potem w `PATH`, i sprawdza `minVersion` (`--version`); bez niego język jest niedostępny z komunikatem `help` |
| `inputs`, `markers` | słowa do komunikatów („Use … or a directory”, „No … found”) |
| `detect.markers` | pliki projektu: folder zawiera kod języka, gdy pod takim plikiem są pliki źródłowe |
| `detect.sources` | rozszerzenia plików źródłowych (`.d.ts` i `.min.js` się nie liczą) |
| `detect.inputs` | wzorce nazw plików, które można podać wprost (`*.ts`, `package.json`) |
| `detect.ignoreDirs` | foldery, do których wykrywanie nie zagląda (foldery z kropką są pomijane zawsze) |
| `display` | jak mapa nazywa poziomy tego języka i kod spoza analizy (trafia do `source.languages`) |
| `unused` | reguły nieużywanego kodu: `memberAccessibility`, `typeAccessibility`, `skipAttributed`, `skipTags`, `skipMemberKinds`, `skipModifiers`, `skipNames`, `skipNamePattern`, `skipParentKinds`, `skipParentTags`, `skipTypeTags` |

## Uruchomienie

CodeMap uruchamia `command` w folderze wtyczki i pisze na **stdin** żądanie (UTF-8 bez BOM), po czym zamyka stdin:

```json
{
  "protocol": 1,
  "command": "analyze",
  "root": "/abs/folder",
  "target": "/abs/folder-albo-plik",
  "output": "/tmp/codemap-…/fragment.json",
  "codemapVersion": "0.1.0",
  "options": { "includeTests": true, "includeGenerated": false, "includeExternal": false }
}
```

* `target`: plik lub folder do analizy; `root`: folder, względem którego mają być ścieżki (`location.file`).
* Wynik wtyczka zapisuje do pliku **`output`** (nie na stdout: duże grafy i przypadkowy `console.log` by go psuły).
* Postęp i ostrzeżenia idą na **stderr** (linia po linii); CodeMap pokazuje je z prefiksem `[id]`.
* Kod wyjścia 0 to sukces. Inny kod to błąd, a jego treścią jest ostatnich 20 linii stderr.
* Anulowanie (np. nowa analiza w trybie live) zabija cały proces wtyczki; `CODEMAP_PLUGIN_TIMEOUT` (sekundy) ogranicza czas analizy.
* Wtyczka nie powinna uruchamiać kodu analizowanego projektu.

## Wynik: surowy graf

Dokument [CodeMap JSON](format.md) w wersji `1.x`:

* `nodes`: drzewo przez `parent`: `project` → `namespace` → węzły poziomu `type` → `member`;
  węzły typów i składowych mają `level` (rodzaje są dowolne, np. `module`, `function`);
* `edges`: zależności (`calls` i `instantiates` z `line` pierwszego wystąpienia; własne rodzaje są dozwolone);
* `location` względem `root`, z `/`; metryki `loc` i `complexity` (1 + liczba decyzji, jak w C#), tagi ról (`entrypoint`, `test`, `controller`…);
* `source` (`path`, `root`, `kind`, `name`), `analysis.warnings`;
* opcjonalnie `analysis.di`: rejestracje kontenera (`registrations`, z `framework`) i zależności konstruktorów (`dependencies`: `consumer`, `service`, `external`, `many`, `optional`). Czasy życia, implementacje i problemy policzy CodeMap według reguł kontenera: `microsoft` (domyślny), `nest`, `angular`; dla nieznanej nazwy tylko powiązania i brakujące rejestracje.

Metryki pochodne (coupling, fan-in/out, abstractness…), cykle, warstwy, nieużywany kod, hotspoty i statystyki liczy CodeMap.

CodeMap sprawdza wynik: węzły spoza `idPrefix`, powtórzone id, nieznane poziomy, rodziców i końce krawędzi, które nie istnieją,
oraz ścieżki spoza `root` odrzuca albo poprawia i podsumowuje w ostrzeżeniu, zamiast przerywać analizę.

## Kilka języków w jednym folderze

Dla folderu CodeMap uruchamia każdy język, który coś w nim wykryje, i łączy wyniki w jedną mapę (np. solucja C# i aplikacja
TypeScript obok siebie). Gdy jeden język zawiedzie (np. brak Node.js), pozostałe i tak dają mapę, a błąd trafia do ostrzeżeń.
`--lang csharp` albo `--lang typescript` ogranicza analizę do wybranych języków.

## Nowa wtyczka

1. Zrób folder z `codemap-plugin.json` i programem, który czyta żądanie ze stdin i zapisuje graf do `output`.
2. Wskaż go: `codemap --plugins <folder> --version` powinno go wypisać.
3. `codemap <ścieżka> --plugins <folder>`; ostrzeżenia z walidacji pokażą, co trzeba poprawić.

Najprostszy przykład to wtyczka testowa [`tests/CodeMap.Tests/Plugins/stub`](../tests/CodeMap.Tests/Plugins/stub).
