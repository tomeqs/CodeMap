from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.deps import SessionDep, Settings, get_report_cache, get_settings
from app.models import Order

router = APIRouter(prefix="/orders", tags=["orders"])


class OrderOut(BaseModel):
    id: int
    total: int


class OrderService:
    def __init__(self, db: SessionDep, settings: Annotated[Settings, Depends(get_settings)]) -> None:
        self.db = db
        self.settings = settings

    def find(self, order_id: int) -> Order:
        order = self.db.get(Order, order_id)
        if order is None:
            raise HTTPException(status_code=404)
        return order

    def pay(self, order_id: int) -> Order:
        order = self.find(order_id)
        order.pay()
        return order


@router.get("/{order_id}", response_model=OrderOut)
def read_order(order_id: int, service: Annotated[OrderService, Depends()]) -> Order:
    return service.find(order_id)


@router.post("/{order_id}/pay", response_model=OrderOut)
def pay_order(order_id: int, service: Annotated[OrderService, Depends()]) -> Order:
    return service.pay(order_id)


@router.get("/report")
def report(cache: dict = Depends(get_report_cache)) -> dict:
    return cache
