from pydantic_settings import BaseSettings


class ApiSettings(BaseSettings):
    database_url: str = "sqlite://"
    tax_rate: int = 20
