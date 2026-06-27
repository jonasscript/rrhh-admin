from fastapi import APIRouter, File, HTTPException, UploadFile, status

# Auth is intentionally disabled for the public OCR endpoint.
# from src.auth.oauth2 import get_current_client
from src.config.settings import settings
from src.models.schemas import AccountMovementsResponse, OCRResponse
from src.services.ocr_service import ocr_service
from src.utils.image_processor import pdf_to_images, preprocess_image

router = APIRouter(prefix="/ocr", tags=["OCR"])

_ALLOWED_MIME_TYPES = {"image/jpeg", "image/jpg", "image/png", "application/pdf"}


@router.post(
    "/scan",
    response_model=OCRResponse,
    summary="Scan a payment receipt",
    description=(
        "Upload a payment-receipt image (JPG / PNG) or PDF. "
        "The service extracts text with EasyOCR and returns structured "
        "payment information (amount, date, reference, bank, etc.)."
    ),
)
async def scan_payment_receipt(
    file: UploadFile = File(..., description="Receipt image (JPG/PNG) or PDF — max 10 MB"),
    # _client_id: str = Depends(get_current_client),  # Auth disabled: public endpoint.
) -> OCRResponse:
    # ── Content-type guard ────────────────────────────────────────────────
    content_type = (file.content_type or "").lower()
    if content_type not in _ALLOWED_MIME_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=(
                f"Unsupported media type '{content_type}'. "
                "Accepted: image/jpeg, image/png, application/pdf"
            ),
        )

    contents = await file.read()

    # ── Size guard ────────────────────────────────────────────────────────
    if len(contents) > settings.max_file_size_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds maximum allowed size of {settings.MAX_FILE_SIZE_MB} MB.",
        )

    try:
        # ── PDF → first page ─────────────────────────────────────────────
        if content_type == "application/pdf":
            pages = pdf_to_images(contents)
            if not pages:
                raise ValueError("Could not extract any page from the PDF.")
            image_bytes = preprocess_image(pages[0])
        else:
            image_bytes = preprocess_image(contents)

        # ── OCR ──────────────────────────────────────────────────────────
        raw_text, confidence, sorted_blocks, img_dims = ocr_service.process_image(image_bytes)
        extracted = ocr_service.extract_payment_data(raw_text, confidence, sorted_blocks, img_dims)

        return OCRResponse(
            success=True,
            filename=file.filename or "unknown",
            extracted_data=extracted,
        )

    except HTTPException:
        raise
    except Exception as exc:
        return OCRResponse(
            success=False,
            filename=file.filename or "unknown",
            error=str(exc),
        )


@router.post(
    "/movements/scan",
    response_model=AccountMovementsResponse,
    summary="Extract positive account movements from a PDF",
    description=(
        "Upload the Banco Bolivariano movement-statement PDF. The endpoint "
        "returns a mapped array with payment_date, sign, amount and description."
    ),
)
async def scan_account_movements(
    file: UploadFile = File(..., description="Movement statement PDF — max 10 MB"),
) -> AccountMovementsResponse:
    """Public endpoint consumed only through the RRHH backend proxy."""
    content_type = (file.content_type or "").lower()
    if content_type != "application/pdf" and not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Accepted: application/pdf",
        )

    contents = await file.read()
    if len(contents) > settings.max_file_size_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds maximum allowed size of {settings.MAX_FILE_SIZE_MB} MB.",
        )

    try:
        records = ocr_service.extract_account_movements(contents)
        return AccountMovementsResponse(
            success=True,
            filename=file.filename or "unknown",
            records=records,
        )
    except HTTPException:
        raise
    except Exception as exc:
        return AccountMovementsResponse(
            success=False,
            filename=file.filename or "unknown",
            error=str(exc),
        )
