# shop-py: przykład dla CodeMap w Pythonie

Ten sam sklep co [`samples/Shop`](../Shop) i [`samples/shop-ts`](../shop-ts), tylko w Pythonie: workspace uv z biblioteką
domenową i czterema aplikacjami. Służy do pokazania i testowania mapy Pythona, nie do uruchamiania (nie ma środowiska
wirtualnego ani zainstalowanych pakietów; CodeMap ich nie potrzebuje).

```
libs/domain     shop-domain   pieniądze, katalog, zamówienia, rabaty (czysty Python, re-eksporty w __init__.py)
apps/api        shop-api      FastAPI: routery z prefiksami, Depends, SQLAlchemy, Pydantic, test pytest z fiksturą
apps/backoffice backoffice    Django + DRF: modele, widoki, URLconfy z include, router, admin, sygnał, komenda, middleware
apps/legacy     legacy        Flask: blueprint zarejestrowany pod /catalog w create_app
apps/worker     worker        Celery (zadania) i typer (komendy wywołujące zadania przez .delay)
```

```bash
codemap samples/shop-py      # sam Python: 5 projektów, moduły jako jednostki mapy
codemap samples              # razem z C# (samples/Shop, samples/Booking) i TypeScriptem: jedna mapa
codemap samples/shop-py --checks
```

Co ma być widać na mapie (i co sprawdzają testy `SampleTests` oraz smoke testy viewera):

| Przypadek | Gdzie | Co pokazuje mapa |
|---|---|---|
| Zależność między projektami workspace’u | `shop-api` i `worker` importują `shop_domain` (`[tool.uv.sources] shop-domain = { workspace = true }`) | `projectReference` do `shop-domain`, nie paczka z PyPI |
| Re-eksport w `__init__.py` | `from shop_domain import Order` | `OrdersService.place` woła `Order.add_line` w `orders.py`; `__init__.py` ma tag `barrel` |
| Trasy FastAPI z prefiksami | `APIRouter(prefix="/orders")` + `include_router(…, prefix="/api")` | `place_order` to `POST /api/orders/`, `pay_order` to `POST /api/payments/{order_id}` |
| `Depends` w widoku DI | `SessionDep = Annotated[Session, Depends(get_session)]`, `OrdersDep`, `@lru_cache get_settings` | `get_session` per request (scoped), `get_settings` singleton, endpointy jako `controller` |
| Captive dependency | `@lru_cache get_price_list(session: SessionDep)` | błąd DI `captive`: buforowana na zawsze zależność bierze sesję żądania |
| Protocol i implementacja | `PaymentGateway(Protocol)`, `FakePaymentGateway(PaymentGateway)` | `implements`; widok Flow z `POST /api/payments/{order_id}` dochodzi przez `PaymentsService.pay` do `Order.pay` |
| Cykl | `OrdersService` ↔ `PaymentsService` (import pod `TYPE_CHECKING` i adnotacja w drugą stronę) | cykl na poziomie modułów `services/orders.py` ↔ `services/payments.py`; do tego cykl pakietów `shop_api` ↔ `routers` ↔ `services` (main importuje routery, a routery `deps`) |
| Martwy kod | `OrdersService._legacy_total` | jedyny kandydat „possibly unused” |
| Modele SQLAlchemy | `OrderRow`, `LineRow` (`DeclarativeBase`, `relationship`, `ForeignKey("orders.id")`) | tag `entity`, `holds` między nimi |
| Django | modele z `ForeignKey(Customer)` i `ForeignKey("Order")`, `View`, `ModelViewSet` z `@action`, `include("orders.urls")`, `include(router.urls)` | encje z `holds`; trasy `GET /orders/<int:pk>/`, `/orders/`, `POST /orders/api/{pk}/close/` |
| Co Django ładuje sam | `admin.py`, `apps.py` (`ready`), `@receiver(post_save, sender=Order)`, `management/commands/close_stale.py`, `MIDDLEWARE` w settings | punkty wejścia, `subscribes` do `Order`, `AuditMiddleware` z tagiem `middleware`, `settings.py` jako `config` |
| Flask | `Blueprint` zarejestrowany z `url_prefix="/catalog"`, `@catalog.errorhandler(404)` | `GET /catalog/`, `GET, HEAD /catalog/<sku>`; `create_app` i handler błędu to punkty wejścia |
| Celery i typer | `@app.task`, `send_receipt.delay(…)` w komendzie typer | zadania z tagami `handler` i `entrypoint`, komenda `resend` woła `send_receipt` |
| pytest | fikstura `service` w `tests/conftest.py`, parametr testu o tej nazwie | test woła fiksturę; pliki testów mają tag `test` |
| Kontrola w funkcji | `show_product(sku, fields=[])` | z `--checks`: `code.mutable-default` |
