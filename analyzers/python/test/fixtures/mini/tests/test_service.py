from mini.orders.service import MemoryRepository, OrderService


def test_place_counts_the_lines():
    service = OrderService(MemoryRepository(), notify=lambda text: None)
    assert service.place(1, ["a", "b"]).total == 2
