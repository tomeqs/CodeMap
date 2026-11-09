from shop_domain import Money

from worker.celery_app import app


@app.task(bind=True, max_retries=3)
def send_receipt(self, order_id: int, cents: int) -> str:
    return f"receipt for {order_id}: {Money(cents)}"


@app.task
def nightly_report() -> int:
    return 0
