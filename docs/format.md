# CodeMap JSON: specyfikacja formatu (wersja 1.1)

Plik `*.codemap.json` opisuje kod jako **graf skierowany**:

* **węzły** (`nodes`) to elementy kodu: projekty, paczki, namespace’y, typy i ich składowe;
  inne języki niż C# mają swoje odpowiedniki (w TypeScripcie: paczki, foldery, pliki i deklaracje), patrz [Poziomy i języki](#poziomy-i-języki);
* **drzewo zawierania** budują pola `parent` (projekt → namespace → typ → typ zagnieżdżony / składowa);
* **krawędzie** (`edges`) to wszystkie pozostałe relacje, każda z rodzajem (`kind`) i wagą (`weight`).

Krawędź `contains` nie jest zapisywana jawnie, bo wynika z pól `parent`. Eksportery GraphML, DGML i Cypher ją materializują.

JSON Schema: [`codemap.schema.json`](codemap.schema.json).

## Dokument

| Pole | Typ | Opis |
|---|---|---|
| `format` | `"codemap"` | znacznik formatu |
| `version` | `"1.1"` | wersja formatu; nowe pola mogą się pojawiać bez zmiany wersji głównej (1.1 dodała `level`, `language`, `source.languages`, nowe rodzaje węzłów i `imports`) |
| `generator` | `{ name, version }` | narzędzie, które wygenerowało plik |
| `generatedAt` | ISO 8601 | czas analizy |
| `source` | obiekt | `path` (analizowany plik/katalog), `root` (katalog bazowy dla ścieżek plików), `kind` (`solution`/`project`/`directory`/`file`), `name`, `languages` (języki w mapie, patrz niżej), opcjonalnie `git` (`branch`, `commit`, `commitsAnalyzed`, `since`) |
| `stats` | `{ string: int }` | liczniki: `projects`, `namespaces`, `types`, `members`, `edges`, `lines`, `files`, `cycles`, `edges.<kind>`… |
| `nodes` | `Node[]` | węzły |
| `edges` | `Edge[]` | krawędzie |
| `analysis` | obiekt | wnioski: `cycles`, `hotspots`, `mostComplex`, `mostDepended`, `unusedCandidates`, `warnings` |

## Węzeł (`Node`)

| Pole | Wymagane | Opis |
|---|---|---|
| `id` | ✔ | stabilny identyfikator (patrz niżej) |
| `kind` | ✔ | rodzaj węzła |
| `level` | | poziom mapy: `project`, `namespace`, `type`, `member`; bez niego poziom wynika z `kind` (tak jest w C#), języki, w których ten sam rodzaj leży na innym poziomie, podają go zawsze |
| `name` | ✔ | krótka nazwa (`Order`, `Repository<T>`, `AddLine`, `this[]`) |
| `fullName` | | pełna nazwa (`Shop.Domain.Orders.Order`) |
| `parent` | | id węzła nadrzędnego |
| `project` | | id projektu, w którym zadeklarowano element |
| `language` | | tylko projekty i paczki: id języka z `source.languages` (np. `csharp`) |
| `namespace` | | namespace (tekst) |
| `accessibility` | | `public`, `internal`, `protected`, `private`, `protected internal`, `private protected` |
| `modifiers` | | np. `static`, `abstract`, `sealed`, `partial`, `async`, `virtual`, `override`, `readonly`, `const`, `extension`, `required`, `init` |
| `signature` | | deklaracja w składni C# (`public Task<Order?> FindAsync(Guid id, CancellationToken ct = default)`); dla projektów: SDK · TFM · OutputType; dla paczek: wersja |
| `baseType` | | pełna nazwa klasy bazowej (także zewnętrznej, np. `Microsoft.AspNetCore.Mvc.ControllerBase`) |
| `location` | | `{ file, line, endLine }`; `file` jest względny do `source.root`, z `/` jako separatorem; linie liczone od 1 |
| `extraLocations` | | pozostałe deklaracje typów `partial` |
| `attributes` | | nazwy atrybutów bez sufiksu `Attribute` (`ApiController`, `Fact`) |
| `tags` | | role i wnioski (patrz niżej) |
| `doc` | | pierwsze zdania `<summary>` z dokumentacji XML |
| `external` | | `true` dla elementów spoza analizowanego kodu (BCL, NuGet) |
| `metrics` | | `{ nazwa: liczba }` (patrz niżej) |

### Rodzaje węzłów

| Poziom | `kind` |
|---|---|
| projekt | `project`, `package` (NuGet), `assembly` (kontener typów zewnętrznych) |
| namespace | `namespace` (osobny węzeł dla każdej pary projekt + namespace) |
| typ | `class`, `interface`, `struct`, `record`, `recordStruct`, `enum`, `delegate` |
| składowa | `method` (także operatory, destruktory, top-level statements), `constructor`, `property` (także indeksery i właściwości pozycyjne rekordów), `field`, `event` |

Inne języki mogą używać też `module` (plik), `function`, `typeAlias`, `variable` i własnych rodzajów
(camelCase); węzeł rodzaju spoza tabeli powinien mieć `level`.

### Poziomy i języki

Mapa ma zawsze cztery poziomy: `project` → `namespace` → `type` → `member`. Każdy język mówi, czym one u niego są:
`source.languages` to lista `{ id, name, levels, external }`, gdzie `levels` podaje dla każdego poziomu nazwę w liczbie
pojedynczej i mnogiej, a `external` nazywa kod spoza analizy. Viewer bierze stąd napisy (przyciski poziomów, licznik w rogu).

| Język | `project` | `namespace` | `type` | `member` | `external` |
|---|---|---|---|---|---|
| C# (`csharp`) | Project / Projects | Namespace / Namespaces | Type / Types | Member / Members | BCL / NuGet |
| TypeScript (`typescript`) | Package / Packages | Folder / Folders | File / Files | Declaration / Declarations | npm packages |

W TypeScripcie jednostką mapy jest plik (`module`, `level: "type"`), a klasy, interfejsy, funkcje, aliasy typów
i stałe są jego składowymi (`level: "member"`); metody klasy mają ją za `parent` i też są składowymi. Metryki pliku
liczą się z najgłębszych składowych (metod, funkcji), a klasa dostaje swoje. Paczki i foldery to zwykłe węzły
`project` i `namespace` (folder jest jeden na ścieżkę, jak namespace w C#).

Mapa kilku języków (np. folder z solucją C# i aplikacją TypeScript) ma wszystkie w `source.languages`, a projekty i paczki
każdego mają swój `language`.

### Identyfikatory

* symbole C# używają **documentation comment ID**, tych samych co w plikach XML docs:
  `T:Ns.Type`, `T:Ns.Generic`1`, `M:Ns.Type.Method(System.Int32)`, `M:Ns.Type.#ctor`, `P:Ns.Type.Prop`, `F:Ns.Type._field`, `E:Ns.Type.Changed`;
* gdy ten sam ID występuje w dwóch assembly, kolejne dostają sufiks `@NazwaAssembly`;
* projekty: `project:<Nazwa>`; namespace’y: `namespace:<Projekt>/<Namespace>` (namespace globalny to `(global)`);
* paczki: `package:<Id>`; assembly zewnętrzne: `assembly:<Nazwa>`.

### Tagi

| Tag | Znaczenie |
|---|---|
| `controller`, `dbcontext`, `repository`, `service`, `handler`, `hosted-service`, `middleware`, `hub`, `exception`, `attribute`, `options`, `dto`, `validator`, `factory`, `extensions` | rozpoznane role (dziedziczenie, interfejsy, atrybuty, konwencje nazw) |
| `test`, `test-project` | klasa/metoda testowa, projekt testowy |
| `entrypoint` | `Main`, top-level statements, projekt wykonywalny |
| `generated` | `[GeneratedCode]`, `[CompilerGenerated]` |
| `positional` | właściwość z parametru pozycyjnego rekordu |
| `in-cycle` | element należy do cyklu zależności |
| `unused` | kandydat na martwy kod |
| `hotspot` | jeden z najważniejszych hotspotów |
| `singleton`, `scoped`, `transient` | czas życia typu w kontenerze DI (z rejestracji albo z aktywacji przez framework) |
| `di-issue` | typ ma problem z DI: captive dependency albo brakującą rejestrację |

### Metryki

| Metryka | Gdzie | Opis |
|---|---|---|
| `loc` | typ, składowa, namespace, projekt | linie deklaracji (dla kontenerów: suma typów najwyższego poziomu) |
| `complexity` | składowa, typ, namespace, projekt | złożoność cyklomatyczna (dla typu: suma, czyli WMC) |
| `maxComplexity` | typ | najbardziej złożona składowa |
| `members`, `methods`, `constructors`, `properties`, `fields`, `events`, `enumMembers`, `typeParameters` | typ | liczniki |
| `parameters` | metoda | liczba parametrów |
| `fanIn`, `fanOut` | składowa | liczba różnych metod wołających / wołanych |
| `ca`, `ce` | typ, namespace, projekt | afferent / efferent coupling (tylko wewnątrz analizowanego kodu) |
| `instability` | typ, namespace, projekt | `ce / (ca + ce)` |
| `abstractness`, `distance` | namespace, projekt | udział typów abstrakcyjnych, odległość od main sequence `|A + I − 1|` |
| `dit`, `noc` | klasa | głębokość dziedziczenia, liczba bezpośrednich podklas |
| `types`, `files`, `lines` | namespace / projekt | liczba typów, plików, linii |
| `commits`, `churn`, `authors`, `ageDays` | typ | historia gita plików typu |
| `hotspot` | typ | `sqrt(complexity/max · commits/max)` w zakresie 0..1 |

## Krawędź (`Edge`)

| Pole | Opis |
|---|---|
| `source` | id węzła źródłowego, czyli tego, który zależy |
| `target` | id węzła docelowego, czyli tego, od którego zależy źródło |
| `kind` | rodzaj relacji |
| `weight` | liczba wystąpień w kodzie (np. liczba miejsc wywołania) |
| `line` | tylko `calls` i `instantiates`: linia pierwszego wystąpienia w pliku metody źródłowej. Daje kolejność wywołań (widok Flow, diagram sekwencji) |

Krawędzie są zapisywane na najdokładniejszym możliwym poziomie: `calls` łączy metody, a `injects`
łączy typ z typem. Aby otrzymać graf zależności typów, wystarczy podmienić każdą składową na jej
`parent` i zsumować wagi (tak robią viewer, DGML i opcja `--types-only`).

| `kind` | Źródło → cel | Skąd |
|---|---|---|
| `projectReference` | projekt → projekt | `<ProjectReference>` |
| `packageReference` | projekt → paczka | `<PackageReference>` |
| `inherits` | typ → typ | klasa bazowa, interfejs bazowy interfejsu |
| `implements` | typ → interfejs; składowa → składowa interfejsu | lista bazowa, `FindImplementationForInterfaceMember` |
| `overrides` | składowa → składowa bazowa | `override` |
| `calls` | składowa → metoda | wywołania, grupy metod (`list.Select(Map)`), metody rozszerzające |
| `instantiates` | składowa → typ | `new T(...)`, `new(...)` |
| `throws` | składowa → typ | `throw new T(...)` |
| `catches` | składowa → typ | `catch (T)` |
| `accesses` | składowa → pole/właściwość/zdarzenie | odczyt i zapis |
| `subscribes` | składowa → zdarzenie | `x.Event += handler` / `-=` |
| `uses` | składowa/typ → typ | każda inna referencja do typu (statyczne wywołania, `typeof`, `is`, argumenty generyczne wstrzykiwanych typów) |
| `holds` | pole/właściwość → typ | typ pola, właściwości, zdarzenia (z argumentami generycznymi: `List<Order>` → `Order`) |
| `returns` | metoda → typ | typ zwracany |
| `accepts` | metoda → typ | typy parametrów |
| `injects` | typ → typ | parametry konstruktora (także primary constructors), czyli zależności DI |
| `extends` | metoda/typ → typ | `this T` w metodach rozszerzających, bloki `extension(T)` z C# 14 |
| `decoratedWith` | element → klasa atrybutu | `[Attr]` |
| `changesWith` | typ → typ | historia gita: pliki obu typów zmieniały się w tych samych commitach (patrz `analysis.changeCoupling`) |
| `imports` | plik → plik | języki z modułami (TypeScript): `import` innego pliku |

W innych językach dziedziczenie klas to też `inherits` (np. `class A extends B` w TypeScripcie); `extends` zostaje
dla metod rozszerzających C#. Języki mogą dodawać własne rodzaje krawędzi (camelCase).

`changesWith` (i `contains`) **nie są zależnościami w kodzie**: nie wchodzą do metryk coupling, cykli ani warstw.
Waga to liczba wspólnych commitów.

Typy zewnętrzne pojawiają się w krawędziach tylko z opcją `--external`. Odwołania do składowych zewnętrznych są wtedy podnoszone do ich typu
(np. `calls` → `T:System.Net.Http.HttpClient`).

## `analysis`

```json
{
  "cycles": [{ "level": "type", "nodes": ["T:A", "T:B"] }],
  "hotspots": [{ "id": "T:Shop.Domain.Orders.Order", "score": 0.82 }],
  "mostComplex": [{ "id": "...", "score": 16 }],
  "mostDepended": [{ "id": "...", "score": 13 }],
  "unusedCandidates": ["M:Shop.Application.Orders.OrderQueries.LegacyFormat(Shop.Domain.Orders.Order)"],
  "layers": [{ "level": "namespace", "layers": [["namespace:Shop.Domain/Shop.Domain.Common"], ["..."]], "upward": [...] }],
  "changeCoupling": [{ "source": "T:A", "target": "T:B", "sharedCommits": 7, "strength": 0.78, "hidden": true }],
  "di": { "registrations": [...], "dependencies": [...], "issues": [...] },
  "warnings": ["Could not read ..."]
}
```

`cycles` to silnie spójne składowe (algorytm Tarjana) grafu zależności na poziomach `type`, `namespace` i `project`.

### `layers`

Warstwy architektury wyliczone z grafu zależności na poziomach `project` i `namespace` (wszystkie rodzaje
krawędzi oprócz `contains`, `changesWith` i `packageReference`):

1. silnie spójne składowe w porządku topologicznym, a w każdym cyklu kolejność z heurystyki
   Eadesa–Lina–Smytha (przybliżony minimalny *feedback arc set*, ważony liczbą wystąpień);
2. numer warstwy = najdłuższa ścieżka w dół (warstwa 0 to fundament, od niczego nie zależy);
3. każdy węzeł jest podnoszony tuż pod najniższego użytkownika, więc warstwy są zwarte.

| Pole | Opis |
|---|---|
| `level` | `project` albo `namespace` |
| `layers` | id węzłów w kolejnych warstwach, od dołu (indeks 0) do góry |
| `upward` | krawędzie (`source`, `target`, `kind: "upward"`, `weight`), które nie wskazują w dół: zależność od elementu z tej samej albo wyższej warstwy. Usunięcie ich likwiduje wszystkie cykle, więc to najlepsze kandydatki do refaktoryzacji |

### `changeCoupling`

Typy, których pliki zmieniają się w tych samych commitach (tylko gdy jest historia gita). Plik należy
do największego typu najwyższego poziomu, który w nim leży. Commity z ponad 40 plikami są pomijane
(masowe zmiany nazw, formatowanie).

| Pole | Opis |
|---|---|
| `source`, `target` | id typów (para nieuporządkowana) |
| `sharedCommits` | liczba wspólnych commitów (co najmniej 2, a od 30 commitów w historii: 3) |
| `strength` | `sharedCommits / średnia liczba commitów obu typów`, od 0.3 do 1 |
| `hidden` | `true`, gdy między typami nie ma żadnej zależności w kodzie (w żadną stronę): ukryte powiązanie |

Dla każdej pary jest też krawędź `changesWith`.

### `di`

Pojawia się, gdy w kodzie są rejestracje kontenera DI: `Microsoft.Extensions.DependencyInjection` w C#,
NestJS albo Angular w TypeScripcie (pole `framework`; bez niego to kontener .NET). Każdy kontener ma swoje reguły.

`registrations`: każde wywołanie rejestrujące.

| Pole | Opis |
|---|---|
| `service` | id typu usługi; dla typów frameworka pełna nazwa i `external: true` |
| `implementation` | id implementacji (brak dla fabryk, których nie da się prześledzić) |
| `lifetime` | `singleton`, `scoped`, `transient` (NestJS: `Scope.DEFAULT` / `REQUEST` / `TRANSIENT`; Angular: `providedIn: 'root'` i `NgModule` → singleton, providery komponentu → scoped, komponenty → transient) |
| `effective` | czas życia, który kontener w końcu nadaje, gdy różni się od zadeklarowanego (NestJS: zasięg żądania przechodzi na zależnych) |
| `kind` | `type` (`AddScoped<I, T>()`, `typeof`, `useClass`), `instance` (`AddSingleton(obj)`, `useValue`), `factory` (lambda, `useFactory`), `forward` (`sp => sp.GetRequiredService<T>()`, `useExisting`), `hosted` (`AddHostedService`), `dbcontext` (`AddDbContext`, `Add…DbContext` z Aspire), `httpclient` (typowany `AddHttpClient<T>`), `controller` (kontrolery NestJS), `component` (komponenty, dyrektywy i pipe’y Angulara) |
| `framework` | `nest`, `angular`… (brak: .NET) |
| `key` | klucz dla `AddKeyed*` |
| `registeredIn`, `location` | metoda i miejsce w kodzie, które rejestruje usługę |

Rozpoznawane są też `TryAdd*`, `AddKeyed*` i deskryptory `ServiceDescriptor.Singleton/Scoped/Transient` (także `Keyed*`), np. w `services.TryAdd(...)`.
Jak w kontenerze, wygrywa ostatnia rejestracja, a `IEnumerable<T>` dostaje wszystkie.

`dependencies`: parametry konstruktora (najszerszego publicznego) każdego typu, który buduje kontener,
oraz typów aktywowanych przez framework (kontrolery i huby jako `transient`, middleware konwencyjne jako `singleton`).

| Pole | Opis |
|---|---|
| `consumer`, `consumerLifetime` | typ z konstruktorem i jego czas życia |
| `service` | żądana usługa (id albo pełna nazwa przy `external: true`) |
| `many` | `IEnumerable<T>`: wstrzykiwane są wszystkie rejestracje |
| `optional` | parametr z wartością domyślną |
| `implementations` | co kontener faktycznie wstrzyknie (pusta lista: nic nie jest zarejestrowane) |
| `lifetime` | czas życia wstrzykiwanej usługi |
| `framework` | kontener (brak: .NET); w surowym grafie wtyczki może go pominąć, wtedy decyduje rejestracja konsumenta |

W TypeScripcie zależności to parametry konstruktora (typ albo token z `@Inject(TOKEN)`, `@InjectRepository(E)` → `Repository<E>`,
`@Optional`), właściwości z `@Inject` i wywołania `inject(X)` w Angularze.

`issues`: problemy, błędy najpierw.

| `kind` | `severity` | Znaczenie |
|---|---|---|
| `captive` | `error` | singleton zależy od usługi scoped: jedna instancja jest współdzielona przez wszystkie żądania i żyje dłużej niż jej scope |
| `captive-transient` | `warning` | singleton trzyma usługę transient, która przez to też staje się singletonem |
| `unregistered` | `warning` | konstruktor potrzebuje usługi z analizowanego kodu, której nikt nie rejestruje |
| `interface-injection` | `warning` | NestJS: parametr typu interfejsu bez tokenu; interfejsów nie ma w czasie działania, potrzebny `@Inject(TOKEN)` |
| `scope-bubbling` | `info` | NestJS: usługa zależy od usługi o zasięgu żądania, więc sama też go dostaje (nowa instancja na każde żądanie); to zamierzone, ale kosztuje |
| `unreachable` | `error` | Angular: usługa z `providedIn: 'root'` potrzebuje usługi, którą dostarczają tylko komponenty (`NullInjectorError`) |

Każdy problem ma też `consumer`, `service` i czytelny `message`. Kolejność: błędy, ostrzeżenia, uwagi.

## Przykładowe zapytania

Python, czyli kto bezpośrednio używa interfejsu `IOrderRepository`:

```python
import json
g = json.load(open("Shop.codemap.json"))
parent = {n["id"]: n.get("parent") for n in g["nodes"]}
users = {parent.get(e["source"], e["source"]) for e in g["edges"]
         if e["target"].startswith("M:Shop.Domain.Orders.IOrderRepository") or e["target"] == "T:Shop.Domain.Orders.IOrderRepository"}
print(sorted(users))
```

Neo4j (po imporcie pliku `.cypher`):

```cypher
// łańcuch wywołań od kontrolera do repozytorium
MATCH p = (:Class {name: 'OrdersController'})-[:CONTAINS]->(:Method)-[:CALLS*1..5]->(m:Method)<-[:CONTAINS]-(:Interface {name: 'IOrderRepository'})
RETURN p LIMIT 25;

// najbardziej "centralne" typy
MATCH (t:Code) WHERE t.ca IS NOT NULL RETURN t.fullName, t.ca, t.ce ORDER BY t.ca DESC LIMIT 20;
```
