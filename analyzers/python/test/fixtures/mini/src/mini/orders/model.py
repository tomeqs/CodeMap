"""What an order is."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Status(Enum):
    NEW = "new"
    PAID = "paid"

    def label(self) -> str:
        return self.value.title()


@dataclass
class Line:
    sku: str
    quantity: int = 1


@dataclass
class Order:
    """An order of a customer."""

    id: int
    lines: list[Line] = field(default_factory=list)
    status: Status = Status.NEW

    @property
    def total(self) -> int:
        return sum(line.quantity for line in self.lines if line.quantity > 0)

    def pay(self) -> None:
        if self.status is Status.PAID:
            raise OrderError("already paid")
        self.status = Status.PAID


class OrderError(Exception):
    pass
