from shop_domain import Money, Product


def test_place_keeps_the_lines(service):
    order = service.place(7, [Product("a", "A", Money(100))])
    assert service.find(7) is order
    assert order.total() == Money(100)
