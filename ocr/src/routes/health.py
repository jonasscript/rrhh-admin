from fastapi import APIRouter

from src.config.settings import settings
from src.models.schemas import HealthResponse
from src.services.ocr_service import ocr_service

router = APIRouter(tags=["Health"])


@router.get(
    "/health",
    response_model=HealthResponse,
    summary="Service health check",
)
async def health_check() -> HealthResponse:
    return HealthResponse(
        status="ok",
        version=settings.APP_VERSION,
        ocr_ready=ocr_service.is_loaded(),
    )
