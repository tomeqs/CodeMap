from pydantic import BaseModel


class LineIn(BaseModel):
    sku: str
    quantity: int = 1


class OrderOut(BaseModel):
    id: int
    status: str
    total_cents: int
