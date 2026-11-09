"""Protection of the HTTP API: shared token, bounded concurrent solves, bounded request bodies.

The requests carry patients' home coordinates and appointment times, and one /optimize call at
120 vehicles ties up a core and 2 to 4 GB of memory for about a minute. Hence:

- OPTIMIZER_TOKEN: when set, /optimize and /evaluate answer 401 to any request without
  ``Authorization: Bearer <the same token>`` (compared in constant time). Unset: open, as in
  development, with a warning at startup. /health stays open (container health checks).
- OPTIMIZER_MAX_CONCURRENT_SOLVES (default 2, 1 to 8): solves running at once. Beyond, /optimize
  answers 429 at once rather than queueing (the web shows « réessayez dans une minute »).
- OPTIMIZER_MAX_BODY_MB (default 10): request bodies above it get 413, before being parsed.
  The number of vehicles and trips is bounded by the contract itself (schemas.py).
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import threading
from collections.abc import Iterator
from contextlib import contextmanager

from fastapi import Header, HTTPException, status
from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)

DEFAULT_MAX_CONCURRENT_SOLVES = 2
MAX_CONCURRENT_SOLVES_LIMIT = 8
DEFAULT_MAX_BODY_MB = 10
RETRY_AFTER_SEC = 30


def configured_token() -> str | None:
    """OPTIMIZER_TOKEN, or None when unset or blank (read on every request: tests change it)."""
    token = os.environ.get("OPTIMIZER_TOKEN", "").strip()
    return token or None


def require_token(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency: the bearer token must match OPTIMIZER_TOKEN when one is configured."""
    expected = configured_token()
    if expected is None:
        return
    scheme, _, supplied = (authorization or "").partition(" ")
    supplied = supplied.strip()
    # compare_digest on bytes: constant time for equal lengths, no early exit on the first difference.
    if scheme.lower() != "bearer" or not secrets.compare_digest(supplied.encode(), expected.encode()):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Jeton d'accès absent ou invalide (OPTIMIZER_TOKEN).",
            headers={"WWW-Authenticate": "Bearer"},
        )


def _int_setting(name: str, default: int, low: int, high: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        logger.warning("%s=%r is not an integer: %d used.", name, raw, default)
        return default
    if not low <= value <= high:
        logger.warning("%s=%d is outside %d..%d: %d used.", name, value, low, high, default)
        return default
    return value


def max_concurrent_solves() -> int:
    return _int_setting(
        "OPTIMIZER_MAX_CONCURRENT_SOLVES", DEFAULT_MAX_CONCURRENT_SOLVES, 1, MAX_CONCURRENT_SOLVES_LIMIT
    )


def max_body_bytes() -> int:
    return _int_setting("OPTIMIZER_MAX_BODY_MB", DEFAULT_MAX_BODY_MB, 1, 200) * 1024 * 1024


class SolveSlots:
    """At most ``size`` solves at once; a request beyond gets 429 at once (no queue to pile up)."""

    def __init__(self, size: int) -> None:
        self.size = size
        self._slots = threading.BoundedSemaphore(size)

    @contextmanager
    def hold(self) -> Iterator[None]:
        if not self._slots.acquire(blocking=False):
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=(
                    f"Service d'optimisation occupé : {self.size} calcul(s) déjà en cours. "
                    "Réessayez dans une minute."
                ),
                headers={"Retry-After": str(RETRY_AFTER_SEC)},
            )
        try:
            yield
        finally:
            self._slots.release()


def _too_large(limit: int) -> HTTPException:
    return HTTPException(
        status_code=413,
        detail=f"Requête trop volumineuse (plus de {max(1, limit // (1024 * 1024))} Mo).",
    )


class BodySizeLimit:
    """ASGI middleware: 413 for a body above ``max_bytes``, from Content-Length or while it streams.

    A declared length is refused before anything is read. A chunked body is counted as it arrives:
    the HTTPException raised from ``receive`` reaches FastAPI's exception handler (FastAPI re-raises
    HTTPException met while reading a body), so the client gets the same 413.
    """

    def __init__(self, app: ASGIApp, max_bytes: int | None = None) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = self.max_bytes if self.max_bytes is not None else max_body_bytes()
        declared = dict(scope.get("headers") or []).get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > limit:
            error = _too_large(limit)
            await _send_json(send, error.status_code, error.detail)
            return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise _too_large(limit)
            return message

        await self.app(scope, limited_receive, send)


async def _send_json(send: Send, status_code: int, detail: str) -> None:
    body = json.dumps({"detail": detail}, ensure_ascii=False).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status_code,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": body})


def log_startup_settings(slots: SolveSlots) -> None:
    """One line on the protections in force; a warning when the API is open."""
    if configured_token() is None:
        logger.warning(
            "OPTIMIZER_TOKEN is not set: /optimize and /evaluate accept any caller. Set the same value on the "
            "web app and here, and keep this service on a private network (README, « Sécurité »)."
        )
    logger.info(
        "At most %d concurrent solve(s), request bodies up to %d MB.", slots.size, max_body_bytes() // (1024 * 1024)
    )
