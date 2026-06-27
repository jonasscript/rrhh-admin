from a2wsgi import ASGIMiddleware

from src.config.encoding import configure_utf8_stdio

configure_utf8_stdio()

from src.main import app

application = ASGIMiddleware(app)
