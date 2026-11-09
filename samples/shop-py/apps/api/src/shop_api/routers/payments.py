from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from shop_api.routers.orders import OrdersDep
from shop_api.services.payments import FakePaymentGateway, PaymentsService

router = APIRouter(prefix="/payments", tags=["payments"])


def get_payments(orders: OrdersDep) -> PaymentsService:
    return PaymentsService(orders, FakePaymentGateway())


@router.post("/{order_id}")
def pay_order(order_id: int, payments: Annotated[PaymentsService, Depends(get_payments)]) -> dict:
    return {"receipt": payments.pay(order_id)}
