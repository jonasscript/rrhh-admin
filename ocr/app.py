import json

from src.config.encoding import configure_utf8_stdio

configure_utf8_stdio()

_fastapi_wsgi_app = None


def _health_response(environ, start_response):
    body = json.dumps(
        {
            "status": "ok",
            "service": "ocr",
            "source": "wsgi",
        }
    ).encode("utf-8")
    start_response(
        "200 OK",
        [
            ("Content-Type", "application/json"),
            ("Content-Length", str(len(body))),
        ],
    )
    return [body]


def _get_fastapi_wsgi_app():
    global _fastapi_wsgi_app
    if _fastapi_wsgi_app is None:
        from a2wsgi import ASGIMiddleware
        from src.main import app as fastapi_app

        _fastapi_wsgi_app = ASGIMiddleware(fastapi_app)
    return _fastapi_wsgi_app


def application(environ, start_response):
    path = environ.get("PATH_INFO", "").rstrip("/")
    if path in {"", "/", "/health", "/ocr/health"}:
        return _health_response(environ, start_response)

    return _get_fastapi_wsgi_app()(environ, start_response)
