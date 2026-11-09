from functools import lru_cache
from typing import Annotated, Iterator

from fastapi import Depends, Header
from sqlalchemy.orm import Session

from app.models import engine


class Settings:
    tax_rate = 0.2


@lru_cache
def get_settings() -> Settings:
    return Settings()


def get_db() -> Iterator[Session]:
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_db)]


def verify_key(x_api_key: str = Header()) -> None:
    pass


@lru_cache
def get_report_cache(db: SessionDep) -> dict:
    """Cached for good, yet it asks for the request's session: the captive dependency."""
    return {"db": db}
