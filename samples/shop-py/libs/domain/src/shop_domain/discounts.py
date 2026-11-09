from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Iterable

from .money import Money
from .orders import Order


class Discount(ABC):
    @abstractmethod
    def apply(self, order: Order) -> Money: ...


class PercentOff(Discount):
    def __init__(self, rate: int) -> None:
        self.rate = rate

    def apply(self, order: Order) -> Money:
        return order.total().percent(self.rate)


class BulkDiscount(Discount):
    def apply(self, order: Order) -> Money:
        return order.total().percent(10) if len(order.lines) >= 10 else Money(0)


def best_discount(order: Order, discounts: Iterable[Discount]) -> Money:
    best = Money(0)
    for discount in discounts:
        amount = discount.apply(order)
        if amount.cents > best.cents:
            best = amount
    return best
