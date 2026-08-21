"""Minimal shared-password auth: one password (env var
`AT2_BRIDGE_PASSWORD`), one bearer token per login, checked via HMAC
so no session state needs to live in memory on the server.

If `AT2_BRIDGE_PASSWORD` is unset, auth is fully disabled -- suitable
for local development or a deployment that's already restricted to a
trusted network (e.g. behind Tailscale, as recommended in the README).
This is a deliberate trade-off, not an oversight: don't rely on this
for internet-facing deployments without setting the password.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import time

from fastapi import Header, HTTPException, Query

TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7  # 1 week


def _secret() -> str:
    # Derive a stable per-deployment secret from the password itself so
    # no extra "secret key" env var is needed to manage.
    password = os.environ.get("AT2_BRIDGE_PASSWORD", "")
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def auth_enabled() -> bool:
    return bool(os.environ.get("AT2_BRIDGE_PASSWORD"))


def check_password(password: str) -> bool:
    expected = os.environ.get("AT2_BRIDGE_PASSWORD", "")
    return bool(expected) and hmac.compare_digest(password, expected)


def issue_token() -> str:
    expires_at = int(time.time()) + TOKEN_TTL_SECONDS
    signature = hmac.new(_secret().encode("utf-8"), str(expires_at).encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{expires_at}.{signature}"


def verify_token(token: str | None) -> bool:
    if not auth_enabled():
        return True  # auth disabled deployment-wide
    if not token or "." not in token:
        return False
    expires_at_str, _, signature = token.partition(".")
    try:
        expires_at = int(expires_at_str)
    except ValueError:
        return False
    if expires_at < int(time.time()):
        return False
    expected_sig = hmac.new(_secret().encode("utf-8"), expires_at_str.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected_sig)


def require_auth(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency for HTTP routes: `Authorization: Bearer <token>`."""
    if not auth_enabled():
        return
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:]
    if not verify_token(token):
        raise HTTPException(status_code=401, detail="unauthorized")


def require_auth_ws(token: str | None = Query(default=None)) -> bool:
    """For WebSocket routes: pass `?token=...` in the connection URL,
    check the return value and close the socket yourself if False
    (FastAPI can't raise HTTPException mid-handshake for WS)."""
    return verify_token(token)
