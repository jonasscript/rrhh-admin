from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Auth schemas
# ---------------------------------------------------------------------------

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: Optional[int] = None


# ---------------------------------------------------------------------------
# OCR schemas
# ---------------------------------------------------------------------------

class PaymentType(str, Enum):
    TRANSFER = "transfer"
    DEPOSIT = "deposit"
    UNKNOWN = "unknown"


class ExtractedPaymentData(BaseModel):
    """Structured data extracted from a payment receipt."""

    raw_text: str
    payment_type: PaymentType
    amount: Optional[str] = None
    currency: Optional[str] = None
    date: Optional[str] = None
    reference_number: Optional[str] = None
    origin_account: Optional[str] = None
    destination_account: Optional[str] = None
    bank: Optional[str] = None
    sender_name: Optional[str] = None
    receiver_name: Optional[str] = None
    confidence_score: float
    matched_template: Optional[str] = None  # template id used, or None for generic


class OCRResponse(BaseModel):
    success: bool
    filename: str
    extracted_data: Optional[ExtractedPaymentData] = None
    error: Optional[str] = None


class AccountMovementRecord(BaseModel):
    """One positive account movement extracted from the bank PDF."""

    payment_date: str
    sign: str = "+"
    amount: float
    description: str


class AccountMovementsResponse(BaseModel):
    success: bool
    filename: str
    records: list[AccountMovementRecord] = Field(default_factory=list)
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------

class HealthResponse(BaseModel):
    status: str
    version: str
    ocr_ready: bool
