# Booking: a C# and TypeScript test bed

A small room booking app in both languages, in one folder:

- `server/`: an ASP.NET Core API in C# (`Booking.sln`: Domain, Contracts, Infrastructure, Api; net8.0, framework references only);
- `client/`: an npm workspace in TypeScript (`@booking/core` library, `@booking/bff` Express backend-for-frontend, `@booking/web` front end). It is never installed.

It is written to contain every case the reviews of C# and TypeScript mapping fixed, so that a regression shows on its map.
`codemap samples/Booking` gives one map of both languages. The tests check each row below (`tests/CodeMap.Tests/BookingSampleTests.cs`), and the whole map is kept as a golden file (`tests/CodeMap.Tests/Golden/booking.codemap.json`).

The C# compiles (`dotnet build server/Booking.sln`). Delete `bin/` and `obj/` afterwards before mapping it for the tests: CodeMap reads the global usings in `obj/`. Then regenerate the golden file with `CODEMAP_UPDATE_GOLDEN=1 dotnet test --filter GoldenTests` if the map is meant to change.

## C#

| Case | Where | What the map shows |
|---|---|---|
| Settings in an imported props file | `server/Directory.Build.props` imports `build/Common.props` (framework, `ImplicitUsings`, `Nullable`) | the projects are net8.0 with implicit usings; `Guid`, `List<T>` resolve |
| A global using from `Directory.Build.targets` | `<Using Include="Booking.Domain.Common" />`, not for Contracts | `Reservation` and `ReservationValidator` (no `using` of their own) inherit `Entity<>` and `Validator<>` |
| Generic argument of a base class | `Reservation : Entity<ReservationId>` | `Reservation` uses `ReservationId` |
| Generic argument of a base interface | `IReservationRepository : IRepository<Reservation>` | `IReservationRepository` uses `Reservation` |
| Generic base class over another type | `ReservationValidator : Validator<Reservation>` | `ReservationValidator` uses `Reservation` |
| Property pattern | `ReservationRules.CanCancel`: `is { Status: …, Nights: > 0 }` | `CanCancel` accesses `Status` and `Nights` |
| `nameof` | `ReservationRules.RequireForCancel`: `nameof(Reservation.Cancel)` | no `calls` edge to `Cancel` (it does call `Guard.NotNull`) |
| SDK symbol of the target framework | `Calendar.ParseDay` under `#if NETCOREAPP2_1_OR_GREATER` | the `ReadOnlySpan<char>` overload is on the map, the `#else` one is not |
| `Compile Remove` then `Include` | `Booking.Infrastructure.csproj`, `Legacy/` | `RoomImporter` is on the map, `OldBilling` is not |
| Item group removed only for net48 | `Compat/` | `LegacyClockAdapter` is on the map |
| Item removed for everything but net48 | `Experimental/` | `QuantumScheduler` is not on the map |
| `EnableDefaultItems=false` | `Booking.Contracts.csproj` | the DTOs are on the map, `Drafts/Draft.cs` is not |
| A name ending in "Controller" without ASP.NET | `Infrastructure/Resilience/RetryController.cs` | no `controller` tag, and its unregistered `RetryPolicy` is no DI issue (the container never builds it) |
| Explicit implementations of framework interfaces | `ReservationBook`: `IEnumerable.GetEnumerator`, `IDisposable.Dispose` | not "possibly unused" |
| `TryAdd` after `Add` | `AddBooking()`: `SystemClock`, then `TryAddSingleton<IClock, FixedClock>` | no `FixedClock` registration |
| An override after an extension in another file | `Program.cs`: `AddBooking()`, then `AddSingleton<IClock, UtcClock>()` | the unkeyed `IClock` registrations are `SystemClock`, `UtcClock`; `PricingService` gets `UtcClock` |
| Keyed Type overload | `AddKeyedSingleton(typeof(IClock), "utc", typeof(UtcClock))` | key `utc`, implementation `UtcClock` |
| Enum key | `AddKeyedSingleton<ICache, RedisCache>(CacheKind.Redis)` | key `CacheKind.Redis` |
| Keyed instance | `AddKeyedSingleton<ICache>("memory", new MemoryCache())` | key `memory`, kind `instance` |
| Instance through `typeof` | `AddSingleton(typeof(INotifier), new EmailNotifier())` | kind `instance`, implementation `EmailNotifier` |
| Fluent chain over several lines | `.AddScoped<ReservationService>()…` | each registration on its own line |
| A cast forward | `AddSingleton(sp => (InMemoryReservationRepository)sp.GetRequiredService<IReservationRepository>())` | a `forward` registration of `InMemoryReservationRepository` (not a second `IReservationRepository`), which `ReservationReadModel` gets |
| Closed generics | `IReadModel<Reservation>` (singleton), then `IReadModel<string>` (scoped) | the singleton `OccupancyReport` gets `ReservationReadModel` and holds no scoped service |
| `[FromKeyedServices]` | `ReservationService` | its `IClock` is `UtcClock` (key `utc`), its `ICache` is `RedisCache` |
| An unkeyed request with only keyed registrations | `AvailabilityService(ICache)` | nothing injected; an `unregistered` warning that suggests `[FromKeyedServices]` (the only DI issue of the sample) |

## TypeScript

| Case | Where | What the map shows |
|---|---|---|
| Shorthand properties | `apps/bff/src/routes.ts`: `export const handlers = { list, create, cancel }` | `handlers` calls the three functions |
| `super()` into a package analyzed later | `ReservationsApi extends HttpClient` (`@booking/core`, under `libs/`, after `apps/`) | `ReservationsApi.constructor` calls `HttpClient.constructor` |
| Overloads | `libs/core/src/money.ts`: `formatMoney` | its size (`loc`) is the implementation's, 5 lines |
| A decorator with parentheses in its arguments | `@component({ template: '<button (click)="reload()">…' })` | the signature is `export class ReservationList extends HttpClient` |
| Express route chain on a mounted router | `apiRouter.route('/reservations').get(…).post(…).delete(…)`, mounted at `/api` | `GET`, `POST` and `DELETE /api/reservations`, each on the line of its verb |
| An app typed with a qualified name | `register(app: express.Express)` | the route `GET /health` |
| A route registered inside a function | `register.ts` | `GET /health` has complexity 3, `register` 1, and the top-level code keeps its own 3 |
| A function typed by its variable | `apps/web/src/badge.ts`: `export const Badge: Renderer<BadgeProps> = …` | `Badge` uses `Renderer` and `BadgeProps` |
| Constraint and default of a type parameter | `type Renderer<P extends Labelled = BadgeProps>` | `Renderer` uses `Labelled` and `BadgeProps`, so neither is "possibly unused" |
| CommonJS `require()` variables | `apps/bff/scripts/version.cjs`: `const pkg = require('../package.json')` | the script's top-level code accesses `pkg` and `path`; the script is an entry point |
| A tsconfig path alias | `@/util/dates` (`apps/web/tsconfig.json`) | `reservation-list.ts` imports `util/dates.ts` |
| A bundler-only alias | `~/app.config` (only `vite.config.ts` declares it) | no npm package `~` (the packages are `express`, `@types/express`, `vite`) |
| A folder inside a package | `codemap client/apps/web/src` | the package `@booking/web`, with the same ids as for the whole sample |

## Also on the map, on purpose

- **One type cycle**: `Reservation.Cancel` asks `ReservationRules.CanCancel`, which reads the reservation.
- **One possibly unused file**: `apps/web/src/app.config.ts`. It is only imported through the Vite alias `~/`, which CodeMap cannot follow (a known limit).
- **HTTP calls from TypeScript to the C# controllers** (`/api/reservations`, `/api/rooms`): there are no edges between the languages yet. The sample is ready for them.

## Not covered here

These are covered by the unit tests instead:
- **A built package** (`dist/` next to `src/`): `dist/` is git-ignored.
- **An unreadable folder, a build writing `obj/` during the analysis, Windows paths**: they need a machine state, not code.
