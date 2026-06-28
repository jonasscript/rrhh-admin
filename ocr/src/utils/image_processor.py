import io
from typing import List

from PIL import Image

from src.config.settings import settings


def preprocess_image(image_bytes: bytes) -> bytes:
    """
    Normalise an image for OCR:
    - Convert to RGB (drops alpha, handles palette images)
    - Downscale proportionally if either dimension exceeds ``_MAX_DIM``
    - Re-encode as PNG
    """
    image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

    if max(image.size) > settings.OCR_MAX_DIM:
        ratio = settings.OCR_MAX_DIM / max(image.size)
        new_size = (int(image.width * ratio), int(image.height * ratio))
        image = image.resize(new_size, Image.LANCZOS)

    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def pdf_to_images(pdf_bytes: bytes) -> List[bytes]:
    """
    Convert every page of a PDF to PNG bytes.

    PyMuPDF is used first because it ships the PDF renderer with the Python
    package, so the OCR service does not depend on the operating system having
    Poppler installed or exposed in PATH. The previous pdf2image / Poppler
    implementation is preserved only as a compatibility fallback.

    Raises
    ------
    RuntimeError
        If no PDF renderer is available.
    """
    try:
        import fitz  # PyMuPDF

        document = fitz.open(stream=pdf_bytes, filetype="pdf")
        try:
            # 2x the native resolution gives OCR enough detail for the
            # small table cells in the movement-statement template.
            matrix = fitz.Matrix(2, 2)
            return [
                page.get_pixmap(matrix=matrix, alpha=False).tobytes("png")
                for page in document
            ]
        finally:
            document.close()
    except ImportError:
        # Backwards-compatible fallback for installations that have not yet
        # updated dependencies but already provide Poppler.
        try:
            from pdf2image import convert_from_bytes
        except ImportError as exc:
            raise RuntimeError(
                "No hay un convertidor de PDF disponible. Instale las dependencias "
                "del servicio OCR con pip install -r requirements.txt."
            ) from exc

        pages = convert_from_bytes(pdf_bytes, dpi=200)
        result: List[bytes] = []
        for page in pages:
            buf = io.BytesIO()
            page.save(buf, format="PNG")
            result.append(buf.getvalue())
        return result
