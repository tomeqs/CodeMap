from __future__ import annotations

from typing import TYPE_CHECKING, Optional, Protocol

if TYPE_CHECKING:
    from .model import Order


class Repository(Protocol):
    def get(self, order_id: int) -> Optional[Order]: ...

    def save(self, order: Order) -> None: ...
