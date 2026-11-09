from app.api.orders import read_order


def test_read_order_is_a_route():
    assert callable(read_order)
