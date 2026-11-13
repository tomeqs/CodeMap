from __future__ import annotations

import unittest

from helpers import Workspace


def analyze(files, **options):
    with Workspace(files) as ws:
        return ws.analyze(**options)


def tags(result, name):
    return result.node(name).get("tags", [])


FASTAPI = {
    "requirements.txt": "fastapi\nsqlalchemy\n",
    "app/__init__.py": "",
    "app/main.py": '''
        import uvicorn
        from fastapi import Depends, FastAPI
        from app.api import orders
        from app.deps import verify_key

        app = FastAPI()
        app.include_router(orders.router, prefix="/api", dependencies=[Depends(verify_key)])


        @app.get("/health")
        def health():
            """Says the service is up."""
            return {"ok": True}


        if __name__ == "__main__":
            uvicorn.run(app)
    ''',
    "app/deps.py": '''
        from functools import lru_cache
        from typing import Annotated, Iterator

        from fastapi import Depends, Header
        from sqlalchemy.orm import Session


        class Settings:
            url = "sqlite://"


        @lru_cache
        def get_settings() -> Settings:
            return Settings()


        def get_db() -> Iterator[Session]:
            yield Session()


        SessionDep = Annotated[Session, Depends(get_db)]


        def verify_key(x_key: str = Header()) -> None:
            pass


        @lru_cache
        def get_cached_repo(db: SessionDep):
            return db


        def get_counter():
            return 0
    ''',
    "app/api/__init__.py": "",
    "app/api/orders.py": '''
        from typing import Annotated

        from fastapi import APIRouter, Depends
        from pydantic import BaseModel

        from app.deps import SessionDep, get_cached_repo, get_counter, get_settings, Settings

        router = APIRouter(prefix="/orders", tags=["orders"])


        class OrderOut(BaseModel):
            id: int


        class OrderService:
            def __init__(self, db: SessionDep, settings: Settings = Depends(get_settings)):
                self.db = db

            def find(self, order_id: int) -> OrderOut:
                return OrderOut(id=order_id)


        @router.get("/{order_id}", response_model=OrderOut)
        async def read_order(order_id: int, service: Annotated[OrderService, Depends()]):
            return service.find(order_id)


        @router.post("/", status_code=201)
        def create_order(db: SessionDep, counter: int = Depends(get_counter, use_cache=False)):
            return {}


        @router.delete("/{order_id}", dependencies=[Depends(get_cached_repo)])
        def delete_order(order_id: int):
            return None


        def legacy(order_id: int):
            return None


        router.add_api_route("/legacy/{order_id}", legacy, methods=["PUT"])
    ''',
}


class FastApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = analyze(FASTAPI)

    def test_routes_get_their_full_path_and_are_entry_points(self):
        r = self.result
        self.assertEqual(r.node("app/api/orders.py#read_order")["doc"], "GET /api/orders/{order_id}")
        self.assertEqual(r.node("app/api/orders.py#create_order")["doc"], "POST /api/orders/")
        self.assertEqual(r.node("app/api/orders.py#delete_order")["doc"], "DELETE /api/orders/{order_id}")
        self.assertEqual(r.node("app/api/orders.py#legacy")["doc"], "PUT /api/orders/legacy/{order_id}")
        self.assertEqual(r.node("app/main.py#health")["doc"], "GET /health · Says the service is up.")
        for name in ("app/api/orders.py#read_order", "app/main.py#health"):
            self.assertIn("route", tags(r, name))
            self.assertIn("entrypoint", tags(r, name))
        self.assertIn("controller", tags(r, "app/api/orders.py"))
        self.assertIn("entrypoint", tags(r, "app/main.py"))  # it creates the app
        self.assertIn("dto", tags(r, "app/api/orders.py#OrderOut"))
        self.assertIn("service", tags(r, "app/api/orders.py#OrderService"))
        self.assertTrue(r.has("app/api/orders.py#read_order", "calls", "app/api/orders.py#OrderService.find"))

    def test_depends_is_dependency_injection(self):
        di = self.result.fragment["analysis"]["di"]
        o, d = "py:" + self.result.node("app/api/orders.py")["id"].split(":", 2)[1] + ":app/api/orders.py#", self.result.node("app/deps.py")["id"] + "#"
        registrations = {r["service"]: (r["kind"], r["lifetime"]) for r in di["registrations"]}
        self.assertEqual(registrations[d + "get_db"], ("factory", "scoped"))
        self.assertEqual(registrations[d + "get_settings"], ("factory", "singleton"))  # @lru_cache
        self.assertEqual(registrations[d + "get_cached_repo"], ("factory", "singleton"))
        self.assertEqual(registrations[d + "get_counter"], ("factory", "transient"))  # use_cache=False
        self.assertEqual(registrations[d + "verify_key"], ("factory", "scoped"))
        self.assertEqual(registrations[o + "OrderService"], ("type", "scoped"))  # Depends() of the annotated class
        self.assertEqual(registrations[o + "read_order"], ("controller", "scoped"))
        self.assertTrue(all(r["framework"] == "fastapi" for r in di["registrations"] + di["dependencies"]))
        asks = {(x["consumer"], x["service"]) for x in di["dependencies"]}
        self.assertIn((o + "read_order", o + "OrderService"), asks)
        self.assertIn((o + "OrderService", d + "get_db"), asks)  # through the alias SessionDep
        self.assertIn((o + "OrderService", d + "get_settings"), asks)
        self.assertIn((o + "create_order", d + "get_counter"), asks)
        self.assertIn((o + "delete_order", d + "get_cached_repo"), asks)  # the route's dependencies=[…]
        self.assertIn((o + "delete_order", d + "verify_key"), asks)  # include_router(dependencies=[…])
        self.assertIn((d + "get_cached_repo", d + "get_db"), asks)  # the captive dependency PY3's rules find


class FlaskTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = analyze({
            "app/__init__.py": '''
                from flask import Flask
                from flask_sqlalchemy import SQLAlchemy

                db = SQLAlchemy()


                def create_app():
                    app = Flask(__name__)
                    db.init_app(app)
                    from app.shop import bp
                    app.register_blueprint(bp, url_prefix="/shop")
                    return app
            ''',
            "app/models.py": '''
                from app import db


                class Customer(db.Model):
                    id = db.Column(db.Integer, primary_key=True)
                    orders = db.relationship("Order", back_populates="customer")


                class Order(db.Model):
                    __tablename__ = "orders"
                    id = db.Column(db.Integer, primary_key=True)
                    customer_id = db.Column(db.ForeignKey("customer.id"))

                    def pay(self):
                        pass
            ''',
            "app/shop.py": '''
                from flask import Blueprint
                from flask.views import MethodView

                from app.models import Order

                bp = Blueprint("shop", __name__, url_prefix="/ignored")


                @bp.route("/orders/<int:order_id>", methods=["GET", "POST"])
                def order(order_id):
                    Order.query.get_or_404(order_id).pay()


                @bp.get("/")
                def index():
                    pass


                @bp.errorhandler(404)
                def not_found(error):
                    pass


                class OrderApi(MethodView):
                    def get(self, order_id):
                        pass

                    def delete(self, order_id):
                        pass


                bp.add_url_rule("/api/orders/<int:order_id>", view_func=OrderApi.as_view("order_api"))
            ''',
        })

    def test_blueprint_routes_hooks_and_the_app_factory(self):
        r = self.result
        self.assertEqual(r.node("app/shop.py#order")["doc"], "GET, POST /shop/orders/<int:order_id>")
        self.assertEqual(r.node("app/shop.py#index")["doc"], "GET /shop/")
        self.assertEqual(r.node("app/shop.py#OrderApi.get")["doc"], "GET /shop/api/orders/<int:order_id>")
        self.assertEqual(r.node("app/shop.py#OrderApi.delete")["doc"], "DELETE /shop/api/orders/<int:order_id>")
        self.assertIn("controller", tags(r, "app/shop.py#OrderApi"))
        self.assertIn("entrypoint", tags(r, "app/shop.py#not_found"))
        self.assertIn("entrypoint", tags(r, "app/__init__.py#create_app"))

    def test_flask_sqlalchemy_models(self):
        r = self.result
        self.assertIn("entity", tags(r, "app/models.py#Order"))
        self.assertIn("entity", tags(r, "app/models.py#Customer"))
        self.assertTrue(r.has("app/models.py#Customer.orders", "holds", "app/models.py#Order"))
        self.assertTrue(r.has("app/models.py#Order.customer_id", "holds", "app/models.py#Customer"))  # the default table name
        self.assertTrue(r.has("app/shop.py#order", "calls", "app/models.py#Order.pay"))  # Order.query.get_or_404(…) is an Order


DJANGO = {
    "manage.py": "import os\nif __name__ == '__main__':\n    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'shop.settings')\n",
    "shop/__init__.py": "",
    "shop/settings.py": '''
        INSTALLED_APPS = ["django.contrib.admin", "orders.apps.OrdersConfig"]
        MIDDLEWARE = ["django.middleware.common.CommonMiddleware", "orders.middleware.TimingMiddleware"]
        ROOT_URLCONF = "shop.urls"
    ''',
    "shop/urls.py": '''
        from django.contrib import admin
        from django.urls import include, path

        urlpatterns = [
            path("admin/", admin.site.urls),
            path("orders/", include("orders.urls")),
        ]
    ''',
    "orders/__init__.py": "",
    "orders/apps.py": '''
        from django.apps import AppConfig


        class OrdersConfig(AppConfig):
            name = "orders"

            def ready(self):
                from orders import signals
    ''',
    "orders/middleware.py": "class TimingMiddleware:\n    def __init__(self, get_response):\n        self.get_response = get_response\n",
    "orders/models.py": '''
        from django.db import models


        class Customer(models.Model):
            name = models.CharField(max_length=100)


        class Order(models.Model):
            customer = models.ForeignKey(Customer, on_delete=models.CASCADE)
            parent = models.ForeignKey("self", null=True, on_delete=models.SET_NULL)
            tags = models.ManyToManyField("orders.Tag")

            def pay(self):
                pass


        class Tag(models.Model):
            label = models.CharField(max_length=20)
    ''',
    "orders/views.py": '''
        from django.views.generic import DetailView, View
        from rest_framework import viewsets
        from rest_framework.decorators import action, api_view

        from orders.models import Order


        def order_list(request):
            for order in Order.objects.filter(customer__name="x"):
                order.pay()


        class OrderView(View):
            def get(self, request, pk):
                Order.objects.get(pk=pk).pay()

            def post(self, request, pk):
                pass


        class OrderDetail(DetailView):
            model = Order


        class OrderViewSet(viewsets.ModelViewSet):
            def list(self, request):
                pass

            def retrieve(self, request, pk=None):
                pass

            @action(detail=True, methods=["post"])
            def pay(self, request, pk=None):
                pass


        @api_view(["GET", "POST"])
        def stats(request):
            pass
    ''',
    "orders/urls.py": '''
        from django.urls import include, path, re_path
        from rest_framework.routers import DefaultRouter

        from orders import views

        router = DefaultRouter()
        router.register(r"api/orders", views.OrderViewSet)

        urlpatterns = [
            path("", views.order_list, name="list"),
            path("<int:pk>/", views.OrderView.as_view()),
            re_path(r"^detail/(?P<pk>\\d+)/$", views.OrderDetail.as_view()),
            path("stats/", views.stats),
            path("", include(router.urls)),
        ]
    ''',
    "orders/admin.py": '''
        from django.contrib import admin

        from orders.models import Order


        @admin.register(Order)
        class OrderAdmin(admin.ModelAdmin):
            list_display = ["id"]
    ''',
    "orders/signals.py": '''
        from django.db.models.signals import post_save
        from django.dispatch import receiver

        from orders.models import Order


        @receiver(post_save, sender=Order)
        def order_saved(sender, instance, **kwargs):
            pass
    ''',
    "orders/management/__init__.py": "",
    "orders/management/commands/__init__.py": "",
    "orders/management/commands/close_orders.py": '''
        from django.core.management.base import BaseCommand


        class Command(BaseCommand):
            def handle(self, *args, **options):
                pass
    ''',
    "orders/serializers.py": "from rest_framework import serializers\n\n\nclass OrderSerializer(serializers.ModelSerializer):\n    pass\n",
}


class DjangoTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.result = analyze(DJANGO)

    def test_models_and_their_relations(self):
        r = self.result
        self.assertIn("entity", tags(r, "orders/models.py#Order"))
        self.assertTrue(r.has("orders/models.py#Order.customer", "holds", "orders/models.py#Customer"))
        self.assertTrue(r.has("orders/models.py#Order.tags", "holds", "orders/models.py#Tag"))
        self.assertTrue(r.has("orders/models.py#Order.parent", "holds", "orders/models.py#Order"))  # "self": its own class
        self.assertTrue(r.has("orders/views.py#order_list", "calls", "orders/models.py#Order.pay"))  # Order.objects.filter(…) rows
        self.assertTrue(r.has("orders/views.py#OrderView.get", "calls", "orders/models.py#Order.pay"))  # Order.objects.get(…)

    def test_urls_route_to_views_with_full_paths(self):
        r = self.result
        self.assertEqual(r.node("orders/views.py#order_list")["doc"], "/orders/")
        self.assertEqual(r.node("orders/views.py#OrderView.get")["doc"], "GET /orders/<int:pk>/")
        self.assertEqual(r.node("orders/views.py#OrderView.post")["doc"], "POST /orders/<int:pk>/")
        self.assertEqual(r.node("orders/views.py#OrderDetail")["doc"], "/orders/detail/(?P<pk>\\d+)/")
        self.assertEqual(r.node("orders/views.py#stats")["doc"], "GET, POST /orders/stats/")
        self.assertEqual(r.node("orders/views.py#OrderViewSet.list")["doc"], "GET /orders/api/orders/")
        self.assertEqual(r.node("orders/views.py#OrderViewSet.retrieve")["doc"], "GET /orders/api/orders/{pk}/")
        self.assertEqual(r.node("orders/views.py#OrderViewSet.pay")["doc"], "POST /orders/api/orders/{pk}/pay/")
        for name in ("orders/views.py#OrderView", "orders/views.py#OrderViewSet", "orders/views.py"):
            self.assertIn("controller", tags(r, name))
        self.assertIn("route", tags(r, "orders/views.py#order_list"))

    def test_what_django_loads_itself(self):
        r = self.result
        for name in ("orders/admin.py", "orders/apps.py", "orders/urls.py", "shop/urls.py", "orders/management/commands/close_orders.py",
                     "orders/management/commands/close_orders.py#Command", "orders/management/commands/close_orders.py#Command.handle",
                     "orders/apps.py#OrdersConfig.ready", "orders/signals.py#order_saved"):
            self.assertIn("entrypoint", tags(r, name), name)
        self.assertIn("config", tags(r, "shop/settings.py"))
        self.assertIn("config", tags(r, "orders/admin.py#OrderAdmin"))
        self.assertIn("handler", tags(r, "orders/signals.py#order_saved"))
        self.assertTrue(r.has("orders/signals.py#order_saved", "subscribes", "orders/models.py#Order"))
        self.assertIn("middleware", tags(r, "orders/middleware.py#TimingMiddleware"))
        self.assertTrue(r.has("shop/settings.py#MIDDLEWARE", "uses", "orders/middleware.py#TimingMiddleware"))
        self.assertTrue(r.has("shop/settings.py#ROOT_URLCONF", "uses", "shop/urls.py"))
        self.assertTrue(r.has("shop/settings.py#INSTALLED_APPS", "uses", "orders/apps.py#OrdersConfig"))
        self.assertIn("dto", tags(r, "orders/serializers.py#OrderSerializer"))


class JobsTest(unittest.TestCase):
    def test_celery_tasks_and_their_calls(self):
        r = analyze({
            "proj/__init__.py": "",
            "proj/celery.py": "from celery import Celery\n\napp = Celery('proj')\n",
            "proj/tasks.py": '''
                from celery import shared_task

                from proj.celery import app


                @app.task(bind=True)
                def send_receipt(self, order_id):
                    pass


                @shared_task
                def cleanup():
                    pass


                def place(order_id):
                    send_receipt.delay(order_id)
                    cleanup.apply_async(countdown=5)
                    send_receipt.s(order_id).delay()
            ''',
        })
        for name in ("proj/tasks.py#send_receipt", "proj/tasks.py#cleanup"):
            self.assertIn("handler", tags(r, name))
            self.assertIn("entrypoint", tags(r, name))
        self.assertEqual(r.edge("proj/tasks.py#place", "calls", "proj/tasks.py#send_receipt")["weight"], 2)
        self.assertTrue(r.has("proj/tasks.py#place", "calls", "proj/tasks.py#cleanup"))
        self.assertIn("entrypoint", tags(r, "proj/celery.py"))

    def test_click_and_typer_commands(self):
        r = analyze({
            "cli.py": '''
                import click
                import typer

                app = typer.Typer()


                @click.group()
                def cli():
                    pass


                @cli.command()
                def sync():
                    pass


                @app.command()
                def report():
                    pass


                def main():
                    pass


                def helper():
                    pass


                typer.run(main)
            ''',
        })
        for name in ("cli.py#cli", "cli.py#sync", "cli.py#report", "cli.py#main"):
            self.assertIn("entrypoint", tags(r, name), name)
        self.assertNotIn("entrypoint", tags(r, "cli.py#helper"))


class TestingTest(unittest.TestCase):
    def test_fixtures_by_parameter_name_through_conftest(self):
        r = analyze({
            "tests/conftest.py": "import pytest\n\n\n@pytest.fixture\ndef db():\n    return 1\n\n\n@pytest.fixture(name='client')\ndef make_client(db):\n    return db\n",
            "tests/api/test_orders.py": '''
                import pytest


                @pytest.fixture
                def order(db):
                    return db


                @pytest.mark.parametrize("amount", [1, 2])
                @pytest.mark.usefixtures("db")
                def test_pay(order, client, amount, tmp_path):
                    pass
            ''',
        })
        self.assertEqual(r.targets("tests/api/test_orders.py#test_pay", "calls"), ["tests/api/test_orders.py#order", "tests/conftest.py#db", "tests/conftest.py#make_client"])
        self.assertTrue(r.has("tests/api/test_orders.py#order", "calls", "tests/conftest.py#db"))
        self.assertTrue(r.has("tests/conftest.py#make_client", "calls", "tests/conftest.py#db"))

    def test_a_fixture_is_worked_out_once_and_only_its_own_yield_makes_it_a_generator(self):
        from unittest import mock

        from codemap_python.frameworks.testing import Testing

        files = {
            "app.py": "class Client:\n    def get(self, url): ...\n",
            # A function defined inside may yield as it likes: the fixture itself returns a Client.
            "tests/conftest.py": "import pytest\nfrom app import Client\n\n\n@pytest.fixture\ndef client():\n    def numbers():\n        yield 1\n    return Client()\n\n\n@pytest.fixture\ndef session():\n    yield Client()\n",
            "tests/test_app.py": "".join(f"def test_{i}(client, session):\n    client.get('/')\n    session.get('/')\n\n\n" for i in range(30)),
        }
        given = Testing._given
        with mock.patch.object(Testing, "_given", autospec=True, side_effect=given) as worked_out:
            r = analyze(files)
        self.assertEqual(r.edge("tests/test_app.py#test_7", "calls", "app.py#Client.get")["weight"], 2)
        self.assertEqual(worked_out.call_count, 2, "once per fixture, not once per test")

    def test_test_cases_anywhere_are_tests(self):
        r = analyze({"pkg/checks.py": "import unittest\n\n\nclass PriceChecks(unittest.TestCase):\n    def test_price(self):\n        pass\n\n    def helper(self):\n        pass\n"})
        for name in ("pkg/checks.py#PriceChecks", "pkg/checks.py#PriceChecks.test_price", "pkg/checks.py#PriceChecks.helper"):
            self.assertIn("test", tags(r, name), name)


class RolesTest(unittest.TestCase):
    def test_sqlalchemy_and_sqlmodel_entities_and_roles_by_name(self):
        r = analyze({
            "db.py": '''
                from typing import Optional

                from pydantic_settings import BaseSettings
                from sqlalchemy import ForeignKey
                from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
                from sqlmodel import Field, SQLModel


                class Base(DeclarativeBase):
                    pass


                class Customer(Base):
                    __tablename__ = "customers"
                    id: Mapped[int] = mapped_column(primary_key=True)
                    orders: Mapped[list["Order"]] = relationship(back_populates="customer")


                class Order(Base):
                    __tablename__ = "orders"
                    id: Mapped[int] = mapped_column(primary_key=True)
                    customer_id: Mapped[int] = mapped_column(ForeignKey("customers.id"))
                    customer: Mapped["Customer"] = relationship("Customer")

                    def pay(self):
                        pass


                class Hero(SQLModel, table=True):
                    id: Optional[int] = Field(default=None, primary_key=True)
                    team_id: Optional[int] = Field(default=None, foreign_key="team.id")


                class Team(SQLModel, table=True):
                    id: Optional[int] = Field(default=None, primary_key=True)


                class HeroRead(SQLModel):
                    id: int


                class AppSettings(BaseSettings):
                    url: str = ""


                class OrderRepository:
                    def first(self, customer: Customer):
                        for order in customer.orders:
                            order.pay()


                class PaymentService:
                    pass
            ''',
        })
        for name in ("db.py#Customer", "db.py#Order", "db.py#Hero", "db.py#Team"):
            self.assertIn("entity", tags(r, name), name)
        self.assertNotIn("entity", tags(r, "db.py#Base"))
        self.assertTrue(r.has("db.py#Customer.orders", "holds", "db.py#Order"))
        self.assertTrue(r.has("db.py#Order.customer_id", "holds", "db.py#Customer"))
        self.assertTrue(r.has("db.py#Hero.team_id", "holds", "db.py#Team"))
        self.assertTrue(r.has("db.py#OrderRepository.first", "calls", "db.py#Order.pay"))  # Mapped[list["Order"]]
        self.assertIn("dto", tags(r, "db.py#HeroRead"))
        self.assertIn("options", tags(r, "db.py#AppSettings"))
        self.assertIn("repository", tags(r, "db.py#OrderRepository"))
        self.assertIn("service", tags(r, "db.py#PaymentService"))


if __name__ == "__main__":
    unittest.main()
