from fastapi import APIRouter, Form, HTTPException, status

from src.auth.oauth2 import create_access_token, verify_client
from src.config.settings import settings
from src.models.schemas import TokenResponse

router = APIRouter(prefix="/auth", tags=["Authentication"])


@router.post(
    "/token",
    response_model=TokenResponse,
    summary="OAuth 2 — Client Credentials grant",
    description=(
        "Exchange a `client_id` + `client_secret` (application credentials) "
        "for a short-lived Bearer token. Use `grant_type=client_credentials`."
    ),
)
async def get_token(
    grant_type: str = Form(..., example="client_credentials"),
    client_id: str = Form(..., example="backend-client"),
    client_secret: str = Form(..., example="super-secret-change-in-production"),
) -> TokenResponse:
    if grant_type != "client_credentials":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported grant_type. Only 'client_credentials' is accepted.",
        )

    if not verify_client(client_id, client_secret):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid client_id or client_secret.",
        )

    token = create_access_token(
        data={"sub": client_id, "grant_type": "client_credentials"},
    )

    return TokenResponse(
        access_token=token,
        token_type="bearer",
        expires_in=None,
    )
