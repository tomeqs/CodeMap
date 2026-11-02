# CodeMap

**Mapa kodu dla C# oraz TypeScript / JavaScript**: analizator (Roslyn dla C#, TypeScript compiler API we wtyczce
dla TypeScriptu i JavaScriptu, kolejne języki jako [wtyczki](docs/plugins.md)), który zamienia kod w graf powiązań
(klasy, interfejsy, metody, funkcje, wywołania, importy, dziedziczenie, wstrzykiwanie zależności…), oraz interaktywna
**mapa 3D** z czterema widokami: *Galaxy* (graf siłowy w przestrzeni), *City* (miasto kodu, w którym typy są budynkami),
*Layers* (warstwy architektury wyliczone z kodu), *DI* (kontener zależności z czasami życia usług)
i *Flow* (przepływ wywołań od punktu wejścia, z diagramem sekwencji).

```
codemap MySolution.sln            →  MySolution.codemap.json   (graf: format do dalszego przetwarzania)
                                     MySolution.html           (interaktywna mapa 3D, działa offline)
                                     MySolution.md             (raport: warstwy, DI, cykle, hotspoty, martwy kod…)
```

| Galaxy: typy jako gwiazdy, projekty jako układy słoneczne | City: wysokość = złożoność, kolor = hotspot |
|---|---|
| ![galaxy](docs/img/galaxy.png) | ![city](docs/img/city.png) |
| **Layers: zależności w górę (czerwone) łamią warstwy** | **DI: singleton trzymający usługę scoped (captive dependency)** |
| ![layers](docs/img/layers.png) | ![di](docs/img/di.png) |
| **Flow: przepływ wywołań od akcji kontrolera, z diagramem sekwencji** | **Auto: zoom semantyczny, typ rozwinięty w składowe** |
| ![flow](docs/img/flow.png) | ![zoom](docs/img/zoom.png) |

## Szybki start

### Gotowy program (bez instalowania czegokolwiek)

Z zakładki [Releases](https://github.com/tomeqs/CodeMap/releases) pobierz plik dla swojego systemu,
rozpakuj go i uruchom `codemap` (na Windows wystarczy dwuklik na `codemap.exe`). Otworzy się przeglądarka z ekranem wyboru projektu.

| System | Plik |
|---|---|
| Windows (Intel/AMD, ARM) | `codemap-<wersja>-win-x64.zip`, `…-win-arm64.zip` |
| macOS (Apple Silicon, Intel) | `codemap-<wersja>-osx-arm64.tar.gz`, `…-osx-x64.tar.gz` |
| Linux | `codemap-<wersja>-linux-x64.tar.gz`, `…-linux-arm64.tar.gz` |

To jeden plik wykonywalny (około 50 MB) z wbudowanym środowiskiem .NET, więc działa bez .NET, i obok niego folder
`plugins/` z wtyczką TypeScript / JavaScript (ta potrzebuje Node.js 18+; bez niego mapuje się sam C#). Jeśli .NET SDK
jest zainstalowany, `codemap` i tak go znajdzie i użyje jego bibliotek (najnowszej wersji) do rozwiązywania
typów frameworka. `codemap --version` pokazuje, skąd je bierze.

* **Windows**: plik nie jest podpisany, więc SmartScreen może pokazać ostrzeżenie (*Więcej informacji → Uruchom mimo to*).
* **macOS**: po pobraniu z przeglądarki zdejmij kwarantannę: `xattr -d com.apple.quarantine ./codemap`.
* Warto dodać folder z programem do `PATH`, żeby `codemap` działał z każdego terminala i w skrótach IDE.

### Jako narzędzie .NET

Wymagany jest .NET SDK 8 lub nowszy. Node.js jest potrzebny tylko do przebudowania viewera.

```bash
# z pliku .nupkg z Releases albo zbudowanego lokalnie
dotnet pack src/CodeMap.Cli -o nupkg
dotnet tool install -g CodeMap.Tool --add-source nupkg

codemap            # otwiera aplikację w przeglądarce
```

### Rozszerzenie VS Code

Mapa otwiera się w karcie edytora, a z kodu do mapy i z powrotem przechodzisz jednym kliknięciem:

* **CodeMap: Open Code Map** z palety poleceń albo prawym przyciskiem na `.sln` / `.slnx` / `.csproj` / `package.json` / `tsconfig.json` / folderze w Explorerze;
  gdy w workspace jest C# i TypeScript / JavaScript, rozszerzenie pyta, a folder daje jedną mapę z obydwoma;
* **Open** w panelu szczegółów (albo dwuklik na metodzie) otwiera kod w edytorze obok;
* **Show in Code Map** (`Ctrl+Alt+M`) zaznacza na mapie metodę, funkcję, klasę albo plik spod kursora (C#, TypeScript, JavaScript);
* **Show Call Flow** (menu kontekstowe edytora) pokazuje przepływ wywołań i diagram sekwencji metody albo funkcji spod kursora;
* po zapisaniu pliku `.cs`, `.ts`, `.js`, projektu albo `package.json` mapa sama się odświeża i nie gubi kamery ani zaznaczenia;
* Mermaid i JSON zapisujesz przez okno zapisu VS Code.

Instalacja: plik `codemap-<wersja>.vsix` z [Releases](https://github.com/tomeqs/CodeMap/releases), potem
*Extensions → … → Install from VSIX…* albo `code --install-extension codemap-0.2.0.vsix`. Rozszerzenie ma w sobie
analizator (wymaga .NET SDK 8+, który i tak masz do C#). Bez .NET ustaw `codemap.analyzerPath` na samodzielny plik `codemap`.
TypeScript i JavaScript analizuje wtyczka dołączona do rozszerzenia, na Node.js wbudowanym w VS Code (inny: `codemap.nodePath`).
Kod rozszerzenia jest w [`vscode/`](vscode/).

### Wydawanie nowej wersji

Workflow [`.github/workflows/release.yml`](.github/workflows/release.yml) uruchamia testy i buduje programy
dla 6 platform. Dla każdej sprawdza, czy program uruchamia się i analizuje przykładową solucję, a do tego pakuje narzędzie .NET
i rozszerzenie VS Code (`.vsix`).

```bash
git tag v0.2.0 && git push origin v0.2.0     # GitHub release z plikami i sumami SHA256
```

Workflow można też uruchomić ręcznie (*Actions → Release → Run workflow*). Z podaną wersją (np. `0.2.0`) sam tworzy tag `v0.2.0`
i release. Bez wersji pliki trafiają tylko do artefaktów.
Opcjonalne sekrety repozytorium publikują dalej: `NUGET_API_KEY` wysyła narzędzie do nuget.org
(`dotnet tool install -g CodeMap.Tool`), `VSCE_PAT` rozszerzenie do VS Code Marketplace, a `OVSX_PAT` do Open VSX (VSCodium, Cursor). Lokalnie program dla wybranej platformy buduje:

```bash
dotnet publish src/CodeMap.Cli -c Release -r win-x64 -o dist/win-x64     # albo linux-x64, osx-arm64…
```

### Aplikacja w przeglądarce (najwygodniej)

`codemap` bez argumentów uruchamia lokalny serwer (tylko `127.0.0.1`) i otwiera przeglądarkę
z ekranem wyboru projektu:

* **przeglądarka folderów**: od razu widać, gdzie leżą solucje (◆), projekty i paczki (●), z językiem (C#, TS); dwuklik analizuje;
  folder z solucją i kodem TypeScript obok analizuje się w całości, jako jedna mapa;
* **klonowanie z Gita**: wklej URL repozytorium, a CodeMap sklonuje je do `~/.codemap/repos` i sam znajdzie solucję;
* **ostatnie projekty**: zapamiętane mapy otwierają się natychmiast z cache (`~/.codemap/cache`);
* **postęp analizy na żywo**, z możliwością anulowania;
* **↻** na mapie: ponowna analiza bez utraty kamery, filtrów i zaznaczenia;
* **Live**: mapa sama się odświeża, gdy zapiszesz plik `.cs`/`.csproj`, `.ts`/`.js`, `package.json` albo `tsconfig.json`,
  a toast pokazuje, ile typów przybyło lub ubyło (`node_modules` i wyniki budowania są pomijane).

```bash
codemap                                   # ekran wyboru projektu
codemap ui path/to/MySolution.sln         # od razu analizuje wskazaną solucję
codemap ui . --watch                      # bieżący folder + odświeżanie na żywo
codemap ui --port 6000 --no-open          # inny port, bez otwierania przeglądarki
```

Serwer przyjmuje połączenia tylko z `127.0.0.1`, odrzuca obce nagłówki `Host` (DNS rebinding),
a każde wywołanie API wymaga tokenu sesji, który jest wstrzykiwany tylko do strony serwowanej
przez `codemap`. Inne strony otwarte w przeglądarce nie mogą więc z niego korzystać.

### Skrót w IDE

**Visual Studio**: *Tools → External Tools… → Add*
* Command: `%USERPROFILE%\.dotnet\tools\codemap.exe` (albo ścieżka do pobranego `codemap.exe`)
* Arguments: `ui "$(SolutionDir)$(SolutionFileName)" --watch`

**JetBrains Rider**: *Settings → Tools → External Tools*, Program `codemap`, Arguments `ui "$SolutionPath$" --watch`.

**VS Code**: `.vscode/tasks.json`
```json
{
  "version": "2.0.0",
  "tasks": [{ "label": "CodeMap", "type": "shell", "command": "codemap ui \"${workspaceFolder}\" --watch", "isBackground": true, "problemMatcher": [] }]
}
```

### Generowanie plików (CI, raporty)

```bash
# analiza solucji (.sln / .slnx / .slnf), projektu (.csproj), pliku .cs albo dowolnego folderu
codemap path/to/MySolution.sln -o out --open
# bez instalacji: dotnet run --project src/CodeMap.Cli -- path/to/MySolution.sln -o out
```

Otwórz `out/MySolution.html` w przeglądarce. Plik jest samowystarczalny (viewer i dane w jednym pliku),
więc można go wysłać komuś mailem albo dołączyć do artefaktów CI.

Projekty **nie muszą być zbudowane**. CodeMap czyta `.csproj` bezpośrednio, a typy frameworka bierze
z zainstalowanego .NET. Jeśli wcześniej był `dotnet restore`, typy z paczek NuGet też są rozpoznawane
(przez `obj/project.assets.json`).

### TypeScript i JavaScript

Jeśli na komputerze jest **Node.js 18+**, CodeMap mapuje też TypeScript i JavaScript (wtyczka `analyzers/typescript`,
dołączana do wydań; rozszerzenie VS Code używa Node.js wbudowanego w VS Code). Jednostką mapy jest **plik**: paczki (`package.json`) → foldery → pliki → deklaracje
(klasy, interfejsy, funkcje, typy, stałe) i składowe klas. Krawędzie: `imports` między plikami, wywołania (z kolejnością,
także przez pliki-beczki `index.ts` i przez interfejsy), `new` i JSX, dziedziczenie i implementacje, typy w sygnaturach,
dekoratory, paczki npm i zależności między paczkami monorepo (workspaces) – bez `npm install`.

Frameworki rozpoznawane po importach:

* **Express**: każde `app.get('/orders/:id', …)` / `router.post(…)` / `router.route(…).put(…)` to osobny węzeł trasy
  (`GET /orders/:id`, z prefiksem z `app.use('/catalog', router)`); kod handlerów inline należy do trasy, nazwane handlery
  i middleware są przez nią wywoływane. Widok Flow startuje od tras.
* **NestJS**: kontrolery (trasy z pełną ścieżką), providery, guardy, interceptory, moduły, resolvery GraphQL, gatewaye,
  `@Cron`/`@MessagePattern`… jako punkty wejścia, a w widoku DI kontener Nesta: providery modułów (`useClass`, `useValue`,
  `useFactory`, `useExisting`, tokeny), zasięgi `Scope.REQUEST`/`TRANSIENT`, `@Inject`, `@InjectRepository`, `@Optional`.
  CodeMap pokazuje, gdzie zasięg żądania „rozlewa się” na zależne usługi (uwaga, nie błąd) i gdzie wstrzykiwany jest interfejs bez tokenu.
* **Angular**: komponenty, dyrektywy, pipe’y, moduły i serwisy; `providedIn: 'root'`, providery modułów i komponentów,
  `inject()`. Błąd, gdy serwis z roota potrzebuje czegoś, co dostarczają tylko komponenty.

```bash
codemap path/to/app                 # folder z package.json / tsconfig.json
codemap path/to/repo                # C# i TypeScript w jednym repo: jedna mapa z obu języków
codemap path/to/repo --lang csharp  # tylko jeden język
codemap --version                   # które języki są dostępne (i czy jest Node.js)
```

Przykład: [`samples/shop-ts`](samples/shop-ts) to sklep w TypeScripcie (API w NestJS, bramka w Expressie, front w Angularze
na wspólnej bibliotece domenowej), z celowym cyklem, martwym kodem i problemami kontenerów DI. `codemap samples/shop-ts`
mapuje sam TypeScript, a `codemap samples` daje jedną mapę z nim i z solucją C# [`samples/Shop`](samples/Shop) obok siebie
(poziomy nazywają się wtedy „Projects / Packages”, „Types / Files”…). Mapy z różnych języków nie mają na razie krawędzi
między sobą (np. wywołań HTTP z TypeScriptu do kontrolerów C#).

Jak dopisać kolejny język: [docs/plugins.md](docs/plugins.md).

### Opcje CLI

| Opcja | Znaczenie |
|---|---|
| `-o, --output <dir>` | katalog wyjściowy (domyślnie `codemap-out`) |
| `-f, --format <list>` | `json,html,md,dgml,graphml,cypher` lub `all` (domyślnie `json,html,md`) |
| `--external` | dołącz typy z BCL / NuGet, od których zależy kod (np. `DbContext`, `ILogger<T>`) |
| `--types-only` | usuń węzły składowych (metody, pola…), a ich relacje podnieś na poziom typów; dużo mniejszy plik |
| `--no-tests` | pomiń projekty testowe |
| `--generated` | analizuj też kod generowany (`*.g.cs`, `*.Designer.cs`, `<auto-generated>`) |
| `--lang <list>` | tylko wybrane języki, np. `csharp`, `typescript` (domyślnie każdy, który jest w folderze) |
| `--plugins <dir>` | dodatkowy folder z wtyczkami językowymi ([docs/plugins.md](docs/plugins.md)) |
| `--no-git` / `--git-since "1 year ago"` | historia gita: churn, autorzy, hotspoty |
| `--indent` | sformatowany JSON |
| `--open` | otwórz mapę w przeglądarce |
| `--port <n>` / `--no-open` / `--watch` | opcje aplikacji (`codemap` / `codemap ui`) |
| `codemap export graph.codemap.json -f dgml,cypher` | konwersja istniejącego grafu na inne formaty |

## Co jest najciekawsze w mapie kodu

Sama lista klas niewiele mówi. Wartość mapy bierze się z **relacji** i z tego, co da się z nich policzyć.

### 1. Relacje: 19 rodzajów krawędzi, z wagą (liczbą wystąpień)

| Rodzaj | Przykład w C# | Po co |
|---|---|---|
| `inherits`, `implements` | `class Order : AggregateRoot, IAuditable` | hierarchie, kontrakty |
| `implements` (metoda → metoda interfejsu) | `HandleAsync` → `ICommandHandler.HandleAsync` | nawigacja przez abstrakcje |
| `overrides` | `override decimal DiscountFor(...)` | polimorfizm |
| `calls` | `_repo.AddAsync(order)` | graf wywołań metoda → metoda |
| `instantiates` | `new OrderLine(...)` | kto tworzy obiekty (fabryki, `new` w złych miejscach) |
| `injects` | `public Handler(IOrderRepository repo)` / primary ctor | **graf zależności DI**, czyli prawdziwa architektura aplikacji |
| `holds` | `private readonly List<Order> _orders` | kompozycja i agregacja |
| `accesses` | `order.Total`, `_clock.Now` | odczyt/zapis pól i właściwości (spójność klas) |
| `subscribes` | `bus.Published += OnPublished` | ukryte przepływy przez zdarzenia |
| `throws`, `catches` | `throw new DomainException(..)` | przepływ wyjątków |
| `returns`, `accepts` | sygnatury metod | kontrakty API |
| `extends` | `static IServiceCollection AddShop(this IServiceCollection s)` | metody rozszerzające |
| `decoratedWith` | `[ApiController]`, `[Fact]` | atrybuty |
| `uses` | `typeof(X)`, wywołania statyczne, `is X` | pozostałe zależności |
| `projectReference`, `packageReference` | `.csproj` | architektura na poziomie projektów |
| `changesWith` | dwa pliki zmieniane w tych samych commitach | **ukryte powiązania** z historii gita (to nie jest zależność w kodzie) |

### 2. Metryki (na każdym poziomie: projekt → namespace → typ → składowa)

* **rozmiar**: LOC, liczba składowych, metod, pól…
* **złożoność cyklomatyczna** każdej metody i suma dla typu (WMC)
* **coupling**: `Ca` (ile typów mnie używa), `Ce` (ilu typów ja używam), **instability** `Ce/(Ca+Ce)`
* **abstractness** i **odległość od main sequence** (Robert C. Martin) dla namespace’ów i projektów,
  dzięki czemu widać „strefę bólu” (konkretne i bardzo używane) i „strefę bezużyteczności”
* **DIT / NOC**: głębokość dziedziczenia i liczba podklas
* **fan-in / fan-out** metod

### 3. Wnioski, których nie widać w IDE

* **Hotspoty** = złożoność × częstotliwość zmian z gita. Kod, który jest skomplikowany *i* ciągle
  zmieniany, to najlepsi kandydaci do refaktoryzacji (podejście Adama Tornhilla, „Your Code as a Crime Scene”).
* **Cykle zależności** (Tarjan SCC) między typami, namespace’ami i projektami.
* **Warstwy architektury** wyliczane z samego kodu: każdy namespace i projekt dostaje numer warstwy
  (zależności mają wskazywać w dół), a **zależności „w górę”** to minimalny zestaw krawędzi, których
  usunięcie rozbija wszystkie cykle, czyli najlepsze miejsca do cięcia.
* **Ukryte powiązania z gita** (change coupling): typy, które ciągle zmieniają się razem
  (wspólne commity / średnia liczba zmian), a nie mają między sobą żadnej zależności w kodzie.
  Zwykle to zduplikowana logika, ukryty kontrakt (np. format JSON, nazwa kolejki) albo para klient–serwer.
* **Mapa DI**: rejestracje z `IServiceCollection` (`AddSingleton/Scoped/Transient`, `TryAdd*`, `Keyed*`,
  `AddHostedService`, `AddDbContext`, `AddHttpClient<T>`, fabryki i przekierowania), czas życia każdej usługi,
  a na tej podstawie **captive dependencies** (singleton trzymający usługę scoped albo transient)
  i **brakujące rejestracje** (konstruktor potrzebuje czegoś, czego nikt nie rejestruje).
  Kontrolery, huby i middleware aktywowane przez framework też są brane pod uwagę.
* **Kandydaci na martwy kod**: niepubliczne symbole, do których nic się nie odwołuje.
* **Role** rozpoznawane heurystycznie: controller, DbContext, repository, handler (MediatR/CQRS),
  hosted service, middleware, test, options, DTO, extensions…
* **Analiza wpływu** (w viewerze): co się zepsuje, jeśli zmienię ten typ (przechodnie zależności wsteczne),
  a także **ścieżka** między dwoma dowolnymi elementami („jak kontroler dochodzi do bazy?”).

## Format danych

Głównym formatem jest **CodeMap JSON** (`*.codemap.json`): czytelny dla ludzi, prosty do wczytania
w dowolnym języku i dla LLM-ów. Węzły tworzą drzewo zawierania (`parent`), krawędzie opisują resztę relacji.
Identyfikatory to standardowe *documentation comment IDs* z C# (`T:Shop.Domain.Orders.Order`,
`M:Shop.Domain.Orders.Order.AddLine(Shop.Domain.Catalog.Product,System.Int32)`), więc są stabilne
między uruchomieniami i zgodne z tym, czego używają XML docs i Roslyn.

```json
{
  "format": "codemap", "version": "1.1",
  "nodes": [
    { "id": "T:Shop.Domain.Orders.Order", "kind": "class", "name": "Order",
      "parent": "namespace:Shop.Domain/Shop.Domain.Orders", "project": "project:Shop.Domain",
      "signature": "public sealed class Order : AggregateRoot",
      "location": { "file": "src/Shop.Domain/Orders/Order.cs", "line": 8, "endLine": 69 },
      "tags": ["in-cycle", "hotspot"],
      "metrics": { "loc": 62, "complexity": 16, "ca": 13, "ce": 10, "instability": 0.435 } }
  ],
  "edges": [
    { "source": "M:Shop.Application.Orders.PlaceOrderHandler.HandleAsync(...)",
      "target": "M:Shop.Domain.Orders.Order.Place", "kind": "calls", "weight": 1 }
  ],
  "analysis": { "cycles": [...], "hotspots": [...], "layers": [...], "changeCoupling": [...], "di": {...} }
}
```

Pełna specyfikacja: [docs/format.md](docs/format.md), JSON Schema: [docs/codemap.schema.json](docs/codemap.schema.json).

Formaty dodatkowe:

* **DGML**: otwiera się natywnie w Visual Studio (Code Map / DGML editor), grupy projekt → namespace → typ.
* **GraphML**: Gephi, yEd, Cytoscape, NetworkX.
* **Cypher**: import do Neo4j/Memgraph, potem zapytania typu
  `MATCH p=(c:Class {name:'OrdersController'})-[:CALLS|INJECTS*1..6]->(r:Interface) RETURN p`.
* **Markdown**: raport z przeglądem architektury, który można wkleić do PR-a, wiki albo promptu.

## Mapa 3D

* **Galaxy**: graf siłowy 3D. Projekty to „układy słoneczne”, namespace’y skupiska, typy gwiazdy.
  Kształt oznacza rodzaj (● klasa, ◆ interfejs, ■ struct, ⬟ record, ▲ enum), rozmiar wybraną metrykę,
  a kolor projekt, rodzaj, rolę albo dowolną metrykę (skala *turbo*). Po zaznaczeniu elementu
  cząsteczki płyną wzdłuż krawędzi w kierunku zależności.
* **City**: miasto kodu. Dzielnice to projekty, kwartały namespace’y, budynki typy.
  Powierzchnia odpowiada LOC, wysokość złożoności (lub innej metryce), a kolor np. hotspotom.
  Relacje rysowane są jako łuki nad miastem.
* **Layers**: węzły leżą na poziomych płaszczyznach warstw wyliczonych z widocznych relacji
  (projekty to kolumny przechodzące przez warstwy). Zależności wskazujące w górę są czerwone.
* **DI**: typy budowane przez kontener na płaszczyznach *Singleton / Scoped / Transient / Not registered*.
  Zdrowa zależność wskazuje w dół albo w bok (do czegoś, co żyje co najmniej tak długo),
  captive dependency jest czerwona, a brakująca rejestracja pomarańczowa.
* **Flow**: co się dzieje, gdy wywołasz akcję kontrolera, handler albo `ExecuteAsync` usługi w tle.
  Wywołania są śledzone w kolejności z kodu, przez interfejsy aż do implementacji, którą wstrzyknie kontener DI
  (`IEnumerable<T>` → wszystkie). Górna płaszczyzna to punkt wejścia, a każda niższa to jedno wywołanie głębiej.
  **Diagram sekwencji** pokazuje ten sam przepływ jako uczestników (typy) i komunikaty (`alt` dla kilku możliwych implementacji, `loop` dla `IEnumerable<T>`).
  Można go skopiować jako **Mermaid** (wklejasz do GitHuba, GitLaba, Notion albo dokumentacji) lub pobrać jako `.mmd` / `.svg`.
  Punkt wejścia wybierasz w Insights (*Entry points*), na liście w widoku albo przyciskiem *Call flow ↘* przy dowolnej metodzie.
* **Auto (zoom semantyczny)**: zamiast przełączać poziomy, po prostu lecisz kamerą. Z daleka namespace to jedna gwiazda
  w środku swoich typów. Gdy się zbliżysz, rozwija się w typy, a najbliższe typy w swoje składowe (metody, właściwości, pola).
  Po oddaleniu wszystko zwija się z powrotem. Układ liczony jest raz, więc mapa się nie przestawia, a wyszukiwarka sama doleci do składowej ukrytej w zwiniętym typie.
* Poziomy szczegółowości: **Projects / Namespaces / Types / Members** i drill-down dwuklikiem
  (projekt → namespace’y → typy → składowe, z „duchami” sąsiadów spoza zakresu).
* Panel szczegółów: sygnatura, dokumentacja XML, metryki, tagi, link *Open in VS Code*,
  relacje wychodzące i przychodzące pogrupowane według rodzaju, lista składowych.
* **Neighbours / Dependencies ↓ / Impact ↑ / Path to…** (albo Shift+klik na drugim elemencie).
* Zakładka **Insights**: punkty wejścia (kontrolery, handlery, usługi w tle, `Main`), problemy DI, zależności w górę, ukryte powiązania z gita, cykle, hotspoty,
  najbardziej złożone typy, najczęściej używane typy, możliwy martwy kod. Kliknięcie przenosi do właściwego widoku.
* Kolor **DI lifetime** w każdym widoku (namespace’y i projekty dostają dominujący czas życia swoich typów),
  a w panelu szczegółów sekcje *Dependency injection* i *Changes together with*.
* Filtry rodzajów relacji, projektów, testów, typów zewnętrznych, minimalnej siły powiązania.
* Wyszukiwarka (`/`), skróty: `1`–`4` poziom, `Z` zoom semantyczny, `G`/`C`/`L`/`D`/`E` widok (Galaxy, City, Layers, DI, Flow), `F` dopasuj, `Esc` wstecz.

Viewer można też otworzyć bez danych i przeciągnąć na niego dowolny plik `*.codemap.json`
albo użyć parametru `?data=url.json`.

### GPU

* Mapa rysuje przez **WebGPU**: Metal na macOS, Direct3D 12 na Windows, Vulkan na Linuksie.
  Gdy przeglądarka (albo VS Code) nie ma WebGPU, przechodzi na **WebGL 2**.
  Backend można wymusić w zakładce *Data* (*Graphics → Renderer*), parametrem `?renderer=webgpu|webgl`
  albo ustawieniem `codemap.renderer` w VS Code.
* Układ siłowy liczy się na **GPU** (compute shadery WebGPU): wszystkie węzły równolegle. Pozycje trafiają wprost
  do tekstury, z której rysują shadery, a na CPU wracają tylko co ok. 200 ms (etykiety, klikanie, kamera).
  Siły odpychania do 12 000 elementów liczone są dokładnie, kafelkami w pamięci współdzielonej grupy roboczej.
  Powyżej tej liczby liczone są na siatce: węzły sortowane do komórek w każdym kroku, bliscy sąsiedzi parami,
  dalsi przez środki ładunku komórek na kilku poziomach. Wynik jest w granicach 1% od dokładnego.
  `?layoutMode=grid|exact` wymusza tryb. Do 100 000 elementów na poziom.
* Bez WebGPU układ liczy **Web Worker**, więc mapa i interfejs zostają płynne (do 15 000 elementów).
  Bez workera, na przykład gdy CSP go blokuje, liczy główny wątek z limitem 7000. Małe grafy (do 300 elementów)
  układają się od razu na głównym wątku. `?layout=gpu|worker|main` wymusza wybór.
* Pozycje elementów leżą w teksturze na GPU. Węzły, relacje (wstęgi o miękkich krawędziach, w City łuki)
  i płynące cząsteczki odczytują je w shaderach, więc ruch grafu to jedno przesłanie tekstury na klatkę,
  zamiast przepisywania macierzy i wierzchołków. Przy 20 000 elementów koszt CPU klatki spadł z 5 ms do 0,25 ms.
* Efekty liczone w shaderach, bez kosztu CPU na klatkę:
  - **Poświata:** bloom całej sceny i miękka, oddychająca korona wokół każdego węzła.
  - **Niebo:** tysiące gwiazd migoczących każda w swoim rytmie, kilka jaśniejszych z iskrą, kolorowe mgławice w tle.
  - **Komety:** cząsteczki z warkoczem płyną wzdłuż relacji w stronę zależności. Na żywej mapie płyną też bez zaznaczenia,
    po najmocniejszych relacjach. Gęstość ustawisz w *Particles* (Off / Few / Normal / Many).
  - **Kreski:** zaznaczone i podświetlone relacje, problemy (np. zależności w górę) i *Flow particles on all links*
    mają płynące kreski, więc kierunek widać także bez cząsteczek.
  - **Rozwijanie:** nowy graf wybucha z ciasnej kuli, a węzły po drill-down wychodzą ze swojego rodzica.
    W City budynki wyrastają z ziemi.
  - **Fala:** po kliknięciu fala światła biegnie od węzła po jego relacjach, węzeł po węźle, z pierścieniem uderzeniowym.
* Duże solucje: model, agregacja relacji, semantyczny zoom i automatyczne warstwy działają na indeksach liczbowych.
  Warstwy 20 000 typów liczą się w 0,13 s (wcześniej 37 s), a 100 000 typów w ok. 0,9 s.
* Ruch ustawisz w *Appearance → Motion*:
  - **Living** (domyślnie): mapa żyje w pełnym fps ekranu i pauzuje tylko na ukrytej karcie.
  - **Calm (battery):** ozdoby chodzą w 30 fps i stają 20 s po ostatnim ruchu myszy, a nieruchoma mapa nie zużywa GPU.
    To domyślny tryb bez GPU i przy systemowym *ogranicz ruch*.
  - **Off:** nic nie rusza się samo.
  
  Wybór zostaje w przeglądarce; `?motion=living|calm|off` wymusza tryb.
* Natywne renderery (Metal / Direct3D 12 poza przeglądarką) to osobny temat: [tomeqs/CodeMap#6](https://github.com/tomeqs/CodeMap/issues/6).

### Okulary AR (XREAL 1S / One / One Pro)

Mapa może unosić się w pokoju w okularach AR, które przyjmują obraz 3D side-by-side przez USB-C.
Działa w przeglądarce (`codemap ui`, plik HTML z `codemap -f html`, `npm run dev`), nie w panelu VS Code.

1. Podłącz okulary do komputera (np. Maca) jako rozszerzony ekran.
2. Włącz 3D w okularach: dwuklik przycisku X → *Spatial Screen* → *3D Mode* → *Full SBS*.
   Ekran okularów ma wtedy 3840×1080: lewa połowa trafia do lewego oka, prawa do prawego.
   Jeśli *3D Mode* jest nieaktywne, najpierw przełącz ekran na 16:9 (nie ultra-wide).
3. Opcjonalnie ustaw ekran na *Anchor*, żeby mapa została w miejscu, gdy obracasz głowę
   (śledzenie 3DoF robią same okulary).
4. W mapie kliknij **AR** (albo *Data → Graphics → View in AR glasses…*).
5. W Chrome lub Edge przycisk *Find the glasses screen* znajdzie okulary i Start otworzy mapę na pełnym ekranie właśnie tam.
   W innych przeglądarkach najpierw przeciągnij okno na okulary.

Każde oko dostaje własną kamerę. Czarne tło jest w okularach przezroczyste, a mapa ma rzeczywisty rozmiar
(domyślnie 1,2 m, 1,8 m przed tobą). Etykiety i mały HUD rysują się osobno dla każdego oka.
Kursor myszy (widoczny tylko w jednym oku) zastępuje pierścień na środku widoku:

| Klawisz | Działanie |
|---|---|
| klik / Spacja / Enter | zaznacza to, na co patrzy pierścień |
| przeciąganie, strzałki | obrót mapy |
| kółko, `+` / `−` | bliżej / dalej |
| `[` / `]` | mniejsza / większa mapa |
| `R` | wyśrodkowanie |
| `G` `C` `L` `D` `E`, `1`–`4`, `Z` | widoki i poziomy jak zwykle |
| `Esc` | odznacza, drugi raz wychodzi z AR |

W oknie startowym są: profil okularów (pole widzenia: 1S 52° na ekranie 16:10, na którym obraz 16:9 ma pas
u góry i u dołu; One Pro 57°; One 50°), Full lub Half SBS,
rozstaw oczu (IPD), odległość i rozmiar mapy oraz płaszczyzna ekranu okularów (tam, gdzie oba oczy widzą to samo;
zmniejsz ją, gdy mapa się dwoi). Ustawienia zostają w przeglądarce. `?ar=full` lub `?ar=half` uruchamia tryb od razu.
Pełne 6DoF (chodzenie wokół mapy) wymaga kamery XREAL Eye i natywnego SDK XREAL na Androida, więc tu go nie ma.

## Struktura repozytorium

```
src/CodeMap.Core      analizator, model grafu, metryki, eksportery
  Languages/          języki: ILanguageAnalyzer (każdy język zwraca surowy graf), rejestr, C# (Roslyn)
  Languages/External/ wtyczki językowe: manifest, wyszukiwanie, uruchamianie programu wtyczki, sprawdzanie jej wyniku
  Pipeline/           wspólna część analizy: wybór języków, łączenie ich grafów w jedną mapę, metryki, git, statystyki
  Loading/            .sln/.slnx/.slnf/.csproj → kompilacje Roslyn (bez MSBuild i bez budowania)
  Analysis/           deklaracje, walker referencji, metryki, cykle, warstwy, DI, git (churn, change coupling), tagi
  Export/             JSON, DGML, GraphML, Cypher, Markdown, HTML
src/CodeMap.Server    lokalna aplikacja: API (ASP.NET Core), przeglądarka folderów, klonowanie, cache, tryb live
src/CodeMap.Cli       narzędzie `codemap` (dotnet tool albo samodzielny plik wykonywalny), osadza zbudowany viewer
analyzers/typescript  wtyczka TypeScript / JavaScript (Node.js + TypeScript compiler API), kopiowana do plugins/typescript
vscode/               rozszerzenie VS Code: mapa w webview, przejścia kod ↔ mapa, odświeżanie na żywo
viewer/               mapa 3D: Vite + three.js + d3-force-3d + d3-hierarchy, budowana do jednego pliku HTML
tests/CodeMap.Tests   testy xUnit analizatora i eksporterów; Golden/ to zapisane mapy samples/Shop i małej aplikacji TS
samples/Shop          przykładowa solucja (DDD, DI, zdarzenia, celowy cykl i martwy kod)
samples/shop-ts       ten sam sklep w TypeScripcie: monorepo npm z NestJS, Expressem i Angularem
docs/                 specyfikacja formatu, JSON Schema i protokół wtyczek
```

## Rozwój

```bash
dotnet test                                   # testy analizatora (testy wtyczek potrzebują Node.js)
cd analyzers/typescript && npm install && npm test   # wtyczka TypeScript (npm install jest też potrzebne, żeby ją zbudować z CLI)
cd viewer && npm install && npm run dev       # viewer z hot-reload: http://localhost:5173/?data=sample.codemap.json
npm run build                                 # buduje dist/index.html i kopiuje go do src/CodeMap.Cli/Assets/viewer.html
npm run test:smoke -- --renderers webgpu,webgl   # smoke testy zbudowanego viewera w headless Chromium (bez GPU)
npm run test:smoke -- --samples <folder>      # …także na mapach samples/shop-ts i samples/ (shop-ts.codemap.json, samples.codemap.json)
npm run bench -- --sizes 1k,7k,20k            # benchmark na wygenerowanych grafach, porównanie z bench/baseline.json
```

Benchmark generuje syntetyczne solucje (`node bench/generate.mjs --types 100k`) i mierzy wczytanie, model,
czas ułożenia grafu, płynność orbity, liczbę klatek w bezczynności, picking i przejścia po grafie.
Bez `--headed` Chromium nie ma GPU (SwiftShader), więc liczby zależne od GPU mają sens tylko z `--headed` na prawdziwym komputerze.

Do trybu dev wrzuć dowolny wygenerowany graf do `viewer/public/sample.codemap.json`.
Żeby rozwijać ekran wyboru projektów, uruchom `CODEMAP_DEV=1 codemap ui --no-open` i otwórz
wypisany adres „Dev viewer” (Vite przekierowuje `/api` do serwera).
Zbudowany viewer (`src/CodeMap.Cli/Assets/viewer.html`) jest w repozytorium, żeby samo `dotnet run`
generowało HTML bez Node.js. Po zmianach w `viewer/` trzeba uruchomić `npm run build`.

### Jak to działa

1. `ProjectLoader` czyta solucję i pliki `.csproj` (z `Directory.Build.props`, `Compile Remove`,
   `ImplicitUsings`, `<Using>`, referencjami projektów i paczek).
2. `CompilationFactory` buduje kompilację Roslyn dla każdego projektu w kolejności topologicznej:
   referencje frameworka z działającego runtime’u albo, w samodzielnym pliku wykonywalnym, z zainstalowanego .NET
   lub z runtime’u wbudowanego w program (`FrameworkLocator`), plus ASP.NET Core / WindowsDesktop, gdy są potrzebne,
   paczki z `project.assets.json`, a projekty jako `CompilationReference`.
3. `TypeAnalyzer` + `ReferenceWalker` przechodzą równolegle drzewa składni: deklarują węzły i każdą
   referencję w kodzie rozwiązują przez model semantyczny na krawędź z odpowiednim rodzajem.
4. `GraphMetrics` liczy metryki, cykle i kandydatów na martwy kod, `Layering` warstwy i zależności w górę,
   `DependencyInjectionAnalysis` łączy rejestracje z konstruktorami, a `GitHistory` i `ChangeCouplingAnalysis`
   dokładają churn, hotspoty i ukryte powiązania.
5. Eksportery zapisują wynik; HTML to viewer z osadzonym JSON-em.

Analiza jest „best effort”: kod, który nie kompiluje się w izolacji (np. brak restore’u paczek),
nadal jest mapowany, a nierozwiązane symbole są po prostu pomijane.

## Pomysły na dalszy rozwój

* reguły architektoniczne (np. „Domain nie może zależeć od Infrastructure”) z naruszeniami zaznaczonymi na mapie
  (warstwy wyliczane automatycznie są dobrym punktem startowym)
* porównanie dwóch wersji grafu (diff architektury między commitami / w PR)
* tryb VR/WebXR dla widoku City
* własność kodu (autorzy z gita) jako kolor dzielnic
* serwer MCP, który odpowiada na pytania o architekturę na podstawie grafu
* rozszerzenie Visual Studio z mapą w panelu edytora (dla VS Code już jest)
* krawędzie między językami: wywołania HTTP z TypeScriptu (`fetch`, `HttpClient`) do tras kontrolerów C#
* kolejne języki jako wtyczki (Python, Java, Go): protokół w [docs/plugins.md](docs/plugins.md)
