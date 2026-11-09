from __future__ import annotations

from typing import Optional, Protocol

from sqlalchemy.orm import Session

from shop_api.db import OrderRow
from shop_domain import Order


class OrderRepository(Protocol):
    def get(self, order_id: int) -> Optional[Order]: ...

    def save(self, order: Order) -> None: ...


class SqlOrderRepository(OrderRepository):
    def __init__(self, session: Session) -> None:
        self.session = session

    def get(self, order_id: int) -> Optional[Order]:
        row = self.session.get(OrderRow, order_id)
        return Order(row.id) if row is not None else None

    def save(self, order: Order) -> None:
        self.session.add(OrderRow(id=order.id, status=order.status.value))
