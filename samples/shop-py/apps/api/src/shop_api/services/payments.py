from __future__ import annotations

from typing import Protocol

from shop_api.services.orders import OrdersService
from shop_domain import Money, Order


class PaymentGateway(Protocol):
    def charge(self, order_id: int, amount: Money) -> str: ...


class FakePaymentGateway(PaymentGateway):
    def charge(self, order_id: int, amount: Money) -> str:
        return f"fake-{order_id}-{amount.cents}"


class PaymentsService:
    """Pays orders; it needs OrdersService, which needs it back: the cycle of the sample."""

    def __init__(self, orders: OrdersService, gateway: PaymentGateway) -> None:
        self.orders = orders
        self.gateway = gateway
        orders.payments = self

    def pay(self, order_id: int) -> str:
        order: Order = self.orders.find(order_id)
        receipt = self.gateway.charge(order.id, self.orders.to_pay(order))
        order.pay()
        return receipt
