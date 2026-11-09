from __future__ import annotations

from typing import TYPE_CHECKING

from shop_api.repositories import OrderRepository
from shop_domain import Money, Order, Product, best_discount
from shop_domain.discounts import PercentOff

if TYPE_CHECKING:
    from shop_api.services.payments import PaymentsService


class OrdersService:
    def __init__(self, repository: OrderRepository) -> None:
        self.repository = repository
        self.payments: PaymentsService | None = None

    def place(self, order_id: int, products: list[Product]) -> Order:
        order = Order(order_id)
        for product in products:
            order.add_line(product)
        self.repository.save(order)
        return order

    def find(self, order_id: int) -> Order:
        order = self.repository.get(order_id)
        if order is None:
            raise LookupError(order_id)
        return order

    def to_pay(self, order: Order) -> Money:
        return order.total() + best_discount(order, [PercentOff(5)])

    def _legacy_total(self, order: Order) -> int:
        """Nobody calls this any more: the dead code of the sample."""
        return sum(line.quantity for line in order.lines)
