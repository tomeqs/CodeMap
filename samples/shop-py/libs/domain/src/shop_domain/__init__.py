"""The shop's domain: money, catalog, orders and discounts, in plain Python."""
from .catalog import Product
from .discounts import Discount, best_discount
from .money import Money
from .orders import Order, OrderLine, OrderStatus

__all__ = ["Discount", "Money", "Order", "OrderLine", "OrderStatus", "Product", "best_discount"]
