# shop-ts: przykład dla CodeMap w TypeScripcie

Ten sam sklep co [`samples/Shop`](../Shop), tylko w TypeScripcie: monorepo npm (workspaces) z biblioteką domenową
i trzema aplikacjami. Służy do pokazania i testowania mapy TypeScriptu, nie do uruchamiania (nie ma `node_modules`;
CodeMap ich nie potrzebuje).

```
libs/domain    @shop/domain   encje, Money, zamówienia, rabaty (czysty TypeScript, plik-beczka index.ts)
apps/api       @shop/api      NestJS: kontrolery, serwisy, moduły, tokeny, test *.spec.ts
apps/gateway   @shop/gateway  Express: router zamontowany pod /catalog, handlery inline i nazwane, middleware
apps/web       @shop/web      Angular: komponenty standalone, serwisy providedIn: 'root', pipe
```

```bash
codemap samples/shop-ts      # sam TypeScript: 4 paczki, pliki jako jednostki mapy
codemap samples              # razem z solucją C# samples/Shop: jedna mapa z obu języków
```

Co ma być widać na mapie (i co sprawdzają testy `SampleTests` oraz smoke testy viewera):

* **zależności między paczkami** bez `npm install`: aplikacje importują `@shop/domain`, a CodeMap czyta jej źródła
  (np. `OrdersService.place` → `Order.addLine`);
* **punkty wejścia**: handlery kontrolerów Nesta (`POST /orders/:id/pay`) i trasy Expressa z pełną ścieżką
  (`GET /catalog/:id`); widok Flow idzie od nich przez interfejs `PaymentGateway` do `FakePaymentGateway`;
* **DI Nesta**: `RequestContext` ma `Scope.REQUEST`, więc zależne od niego `OrdersService`, `PaymentsService` i ich kontrolery
  też są tworzone dla każdego żądania (uwagi „scope-bubbling”); `PaymentsService` prosi o interfejs `PaymentGateway`
  bez tokenu, którego Nest nie wstrzyknie (ostrzeżenie);
* **DI Angulara**: `CheckoutService` (`providedIn: 'root'`) potrzebuje `CartState`, którego dostarcza tylko `AppComponent`
  (błąd: root injector go nie da);
* **cykl**: `OrdersService` i `PaymentsService` potrzebują siebie nawzajem (`forwardRef`), tak samo ich moduły;
* **martwy kod**: prywatna metoda `OrdersService.legacyTotal`;
* **testy**: `orders.service.spec.ts` ma tag `test` (opcja „Include tests” go ukrywa).
