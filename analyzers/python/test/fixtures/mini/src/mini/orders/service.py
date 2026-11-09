from __future__ import annotations

import requests

from .model import Line, Order, OrderError
from .ports import Repository


class MemoryRepository(Repository):
    def __init__(self) -> None:
        self._orders: dict[int, Order] = {}

    def get(self, order_id: int) -> Order | None:
        return self._orders.get(order_id)

    def save(self, order: Order) -> None:
        self._orders[order.id] = order


class OrderService:
    def __init__(self, repository: Repository, notify=print) -> None:
        self.repository = repository
        self.notify = notify

    def place(self, order_id: int, skus: list[str]) -> Order:
        order = Order(order_id, [Line(sku) for sku in skus])
        self.repository.save(order)
        self._announce(order)
        return order

    def pay(self, order_id: int) -> None:
        order = self.repository.get(order_id)
        if order is None:
            raise KeyError(order_id)
        try:
            order.pay()
        except OrderError:
            self.notify("already paid")
        requests.post("https://example.com/paid", json={"total": order.total}, timeout=5)

    def _announce(self, order: Order) -> None:
        self.notify(f"order {order.id}: {order.total}")

    def _forgotten(self) -> None:
        self.notify("nobody calls this")


def make_service() -> OrderService:
    return OrderService(MemoryRepository())
