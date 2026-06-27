from datetime import datetime, timezone
from typing import Optional

import bcrypt

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from src.config.settings import settings

_bearer_scheme = HTTPBearer()


def _hash_secret(secret: str) -> bytes:
    return bcrypt.hashpw(secret.encode(), bcrypt.gensalt())


def _check_secret(secret: str, hashed: bytes) -> bool:
    return bcrypt.checkpw(secret.encode(), hashed)


# ---------------------------------------------------------------------------
# Client registry
# ---------------------------------------------------------------------------

def _load_clients() -> dict[str, bytes]:
    """
    Parse OAUTH_CLIENTS env var into {client_id: hashed_secret}.
    Format: "id1:secret1,id2:secret2"
    Secrets are hashed on first load so the plaintext never stays in memory
    beyond startup.
    """
    clients: dict[str, bytes] = {}
    for entry in settings.OAUTH_CLIENTS.split(","):
        parts = entry.strip().split(":", 1)
        if len(parts) == 2:
            client_id, client_secret = parts[0].strip(), parts[1].strip()
            clients[client_id] = _hash_secret(client_secret)
    return clients


# Load once at module import time.
_CLIENTS: dict[str, bytes] = _load_clients()


def verify_client(client_id: str, client_secret: str) -> bool:
    """Return True only when client_id exists and secret matches."""
    hashed = _CLIENTS.get(client_id)
    if hashed is None:
        return False
    return _check_secret(client_secret, hashed)


# ---------------------------------------------------------------------------
# Token creation
# ---------------------------------------------------------------------------

def create_access_token(data: dict) -> str:
    payload = data.copy()
    payload.update({"iat": datetime.now(timezone.utc)})
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


# ---------------------------------------------------------------------------
# Dependency — validates Bearer token on protected endpoints
# ---------------------------------------------------------------------------

async def get_current_client(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
) -> str:
    """FastAPI dependency that extracts and validates the JWT, returning client_id."""
    auth_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired token",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(
            credentials.credentials,
            settings.SECRET_KEY,
            algorithms=[settings.ALGORITHM],
        )
        client_id: str = payload.get("sub")
        if not client_id:
            raise auth_error
        return client_id
    except JWTError:
        raise auth_error
