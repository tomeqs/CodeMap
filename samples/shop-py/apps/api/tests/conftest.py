import pytest

from shop_api.services.orders import OrdersService


class MemoryRepository:
    def __init__(self):
        self.saved = {}

    def get(self, order_id):
        return self.saved.get(order_id)

    def save(self, order):
        self.saved[order.id] = order


@pytest.fixture
def service() -> OrdersService:
    return OrdersService(MemoryRepository())
