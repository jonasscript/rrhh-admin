"""WSGI entrypoint template for PythonAnywhere.

Copy this file's contents into:
/var/www/jonascript_pythonanywhere_com_wsgi.py
"""

import os
import sys


project_home = "/home/jonascript/ocr"

if project_home not in sys.path:
    sys.path.insert(0, project_home)

os.chdir(project_home)

try:
    from dotenv import load_dotenv

    load_dotenv(os.path.join(project_home, ".env"))
except Exception:
    pass

from app import application  # noqa: E402
