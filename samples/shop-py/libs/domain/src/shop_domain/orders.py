from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from .catalog import Product
from .money import Money


class OrderStatus(Enum):
    NEW = "new"
    PAID = "paid"
    CANCELLED = "cancelled"


@dataclass
class OrderLine:
    product: Product
    quantity: int = 1

    @property
    def total(self) -> Money:
        return self.product.price.times(self.quantity)


@dataclass
class Order:
    """An order of a customer, from new to paid."""

    id: int
    lines: list[OrderLine] = field(default_factory=list)
    status: OrderStatus = OrderStatus.NEW

    def add_line(self, product: Product, quantity: int = 1) -> OrderLine:
        if self.status is not OrderStatus.NEW:
            raise OrderClosed(self.id)
        line = OrderLine(product, quantity)
        self.lines.append(line)
        return line

    def total(self) -> Money:
        amount = Money(0)
        for line in self.lines:
            amount = amount + line.total
        return amount

    def pay(self) -> None:
        if self.status is OrderStatus.PAID:
            raise OrderClosed(self.id)
        self.status = OrderStatus.PAID


class OrderClosed(Exception):
    pass
