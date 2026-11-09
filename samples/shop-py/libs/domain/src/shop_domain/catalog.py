from __future__ import annotations

from dataclasses import dataclass

from .money import Money


@dataclass
class Product:
    sku: str
    name: str
    price: Money
