import secrets
from pydantic import field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # App
    APP_NAME: str = "OCR Payment Service"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = False

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # JWT / OAuth2
    SECRET_KEY: str = secrets.token_urlsafe(32)
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60

    # OAuth2 clients — comma-separated "client_id:client_secret" pairs.
    # Secrets are stored hashed at runtime. Change in production.
    OAUTH_CLIENTS: str = "backend-client:super-secret-change-in-production"

    # OCR
    OCR_ENGINE: str = "tesseract"
    OCR_TESSERACT_LANG: str = "spa+eng"
    OCR_TESSERACT_CONFIG: str = "--oem 1 --psm 4"
    OCR_TESSERACT_CMD: str = ""
    OCR_TIMEOUT_SECONDS: int = 8
    OCR_MAX_DIM: int = 1600

    # Upload limits
    MAX_FILE_SIZE_MB: int = 10

    @field_validator("DEBUG", mode="before")
    @classmethod
    def parse_debug(cls, value):
        if isinstance(value, str) and value.lower() in {"release", "production", "prod"}:
            return False
        return value

    class Config:
        env_file = ".env"
        case_sensitive = True
        extra = "ignore"

    @property
    def max_file_size_bytes(self) -> int:
        return self.MAX_FILE_SIZE_MB * 1024 * 1024

    @property
    def ocr_tesseract_language_list(self) -> list[str]:
        return [lang.strip() for lang in self.OCR_TESSERACT_LANG.split("+") if lang.strip()]


settings = Settings()
