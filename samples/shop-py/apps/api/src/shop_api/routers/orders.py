from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends

from shop_api.deps import SessionDep, SettingsDep, get_price_list
from shop_api.repositories import SqlOrderRepository
from shop_api.schemas import LineIn, OrderOut
from shop_api.services.orders import OrdersService
from shop_domain import Money, Product

router = APIRouter(prefix="/orders", tags=["orders"])


def get_orders_service(session: SessionDep) -> OrdersService:
    return OrdersService(SqlOrderRepository(session))


OrdersDep = Annotated[OrdersService, Depends(get_orders_service)]


@router.post("/", status_code=201)
def place_order(lines: list[LineIn], service: OrdersDep, settings: SettingsDep, prices: dict = Depends(get_price_list)) -> OrderOut:
    """Places an order for the given lines."""
    products = [Product(line.sku, line.sku, Money(prices.get(line.sku, 0))) for line in lines]
    order = service.place(1, products)
    total = order.total()
    return OrderOut(id=order.id, status=order.status.value, total_cents=total.cents + total.percent(settings.tax_rate).cents)


@router.get("/{order_id}")
def read_order(order_id: int, service: OrdersDep) -> OrderOut:
    order = service.find(order_id)
    return OrderOut(id=order.id, status=order.status.value, total_cents=service.to_pay(order).cents)
