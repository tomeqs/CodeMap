# CodeMap JSON: specyfikacja formatu (wersja 1.0)

Plik `*.codemap.json` opisuje kod jako **graf skierowany**:

* **węzły** (`nodes`) to elementy kodu: projekty, paczki, namespace’y, typy i ich składowe;
* **drzewo zawierania** budują pola `parent` (projekt → namespace → typ → typ zagnieżdżony / składowa);
* **krawędzie** (`edges`) to wszystkie pozostałe relacje, każda z rodzajem (`kind`) i wagą (`weight`).

Krawędź `contains` nie jest zapisywana jawnie, bo wynika z pól `parent`. Eksportery GraphML, DGML i Cypher ją materializują.

JSON Schema: [`codemap.schema.json`](codemap.schema.json).

## Dokument

| Pole | Typ | Opis |
|---|---|---|
| `format` | `"codemap"` | znacznik formatu |
| `version` | `"1.0"` | wersja formatu; nowe pola mogą się pojawiać bez zmiany wersji głównej |
| `generator` | `{ name, version }` | narzędzie, które wygenerowało plik |
| `generatedAt` | ISO 8601 | czas analizy |
| `source` | obiekt | `path` (analizowany plik/katalog), `root` (katalog bazowy dla ścieżek plików), `kind` (`solution`/`project`/`directory`/`file`), `name`, opcjonalnie `git` (`branch`, `commit`, `commitsAnalyzed`, `since`) |
| `stats` | `{ string: int }` | liczniki: `projects`, `namespaces`, `types`, `members`, `edges`, `lines`, `files`, `cycles`, `edges.<kind>`… |
| `nodes` | `Node[]` | węzły |
| `edges` | `Edge[]` | krawędzie |
| `analysis` | obiekt | wnioski: `cycles`, `hotspots`, `mostComplex`, `mostDepended`, `unusedCandidates`, `warnings` |

## Węzeł (`Node`)

| Pole | Wymagane | Opis |
|---|---|---|
| `id` | ✔ | stabilny identyfikator (patrz niżej) |
| `kind` | ✔ | rodzaj węzła |
| `name` | ✔ | krótka nazwa (`Order`, `Repository<T>`, `AddLine`, `this[]`) |
| `fullName` | | pełna nazwa (`Shop.Domain.Orders.Order`) |
| `parent` | | id węzła nadrzędnego |
| `project` | | id projektu, w którym zadeklarowano element |
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
  "warnings": ["Could not read ..."]
}
```

`cycles` to silnie spójne składowe (algorytm Tarjana) grafu zależności na poziomach `type`, `namespace` i `project`.

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
