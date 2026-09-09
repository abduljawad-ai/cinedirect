"""Pydantic models for the CineDirect API."""
from pydantic import BaseModel


class ResolveRequest(BaseModel):
    url: str


class ResolveResponse(BaseModel):
    direct: str | None = None
    size: int | None = None
    filename: str | None = None
    quality: str | None = None


class ResolveBatchResponse(BaseModel):
    results: list[ResolveResponse | None]


class HealthResponse(BaseModel):
    ok: bool = True
    version: str = "2.0.0"
    relay: str | None = None
