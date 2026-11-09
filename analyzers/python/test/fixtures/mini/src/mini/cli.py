import sys

from mini import Order
from mini.orders.service import make_service


def main(argv: "list[str] | None" = None) -> int:
    service = make_service()
    order: Order = service.place(1, argv or sys.argv[1:])
    service.pay(order.id)
    print(order.status.label())
    return 0


if __name__ == "__main__":
    sys.exit(main())
