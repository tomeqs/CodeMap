from django.apps import AppConfig


class OrdersConfig(AppConfig):
    name = "orders"

    def ready(self) -> None:
        from orders import signals  # noqa: F401 - connects the receivers
