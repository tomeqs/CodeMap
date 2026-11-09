"""The shop's HTTP API."""
from fastapi import Depends, FastAPI

from shop_api.deps import verify_api_key
from shop_api.routers import orders, payments

app = FastAPI(title="Shop API")
app.include_router(orders.router, prefix="/api", dependencies=[Depends(verify_api_key)])
app.include_router(payments.router, prefix="/api")


@app.get("/health")
def health() -> dict:
    """Says the service is up."""
    return {"status": "ok"}
