"""What the routes ask FastAPI for (Depends)."""
from __future__ import annotations

from functools import lru_cache
from typing import Annotated, Iterator

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from shop_api.db import engine
from shop_api.settings import ApiSettings


@lru_cache
def get_settings() -> ApiSettings:
    return ApiSettings()


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]
SettingsDep = Annotated[ApiSettings, Depends(get_settings)]


def verify_api_key(x_api_key: str = Header()) -> None:
    if x_api_key != "secret":
        raise HTTPException(status_code=401)


@lru_cache
def get_price_list(session: SessionDep) -> dict[str, int]:
    """Cached for the whole app, yet it takes the request's session: the captive dependency of the sample."""
    return {}
