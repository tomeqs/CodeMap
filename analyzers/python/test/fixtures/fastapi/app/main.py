from fastapi import Depends, FastAPI

from app.api import orders
from app.deps import verify_key

app = FastAPI(title="Shop")
app.include_router(orders.router, prefix="/api", dependencies=[Depends(verify_key)])


@app.get("/health")
def health() -> dict:
    """Says the service is up."""
    return {"ok": True}
