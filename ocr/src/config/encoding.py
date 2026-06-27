"""Runtime encoding compatibility helpers."""

from __future__ import annotations

import io
import os
import sys


def configure_utf8_stdio() -> None:
    """
    Keep third-party progress/log output from crashing under ASCII-only hosts.

    Some WSGI/Passenger environments expose stdout/stderr with ASCII encoding.
    EasyOCR can emit Unicode progress bars while loading/downloading models, so
    make standard streams UTF-8 capable before the OCR reader is initialized.
    """
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ.setdefault("LANG", "C.UTF-8")
    os.environ.setdefault("LC_ALL", "C.UTF-8")

    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None:
            continue
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
            continue
        except (AttributeError, ValueError, io.UnsupportedOperation):
            pass

        try:
            buffer = stream.detach()
        except (AttributeError, ValueError, io.UnsupportedOperation):
            buffer = getattr(stream, "buffer", None)
        if buffer is None:
            continue
        wrapped = io.TextIOWrapper(buffer, encoding="utf-8", errors="replace")
        setattr(sys, stream_name, wrapped)
