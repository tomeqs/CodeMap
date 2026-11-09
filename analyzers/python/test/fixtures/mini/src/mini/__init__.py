"""A small shop: orders, a repository and a command line."""
from .orders.model import Order, Status
from .orders.service import OrderService

__all__ = ["Order", "OrderService", "Status"]
