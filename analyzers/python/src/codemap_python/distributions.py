"""What PyPI distributions are imported as, where the name differs: PyYAML is `import yaml`.

Distributions not listed are imported by their name in lowercase with - as _ (python-multipart is not, so it is
listed). Keys are normalized names (PEP 503).
"""
from __future__ import annotations

from .ids import normalize

IMPORT_NAMES: dict[str, tuple[str, ...]] = {
    "attrs": ("attr", "attrs"),
    "beautifulsoup4": ("bs4",),
    "django-cors-headers": ("corsheaders",),
    "django-crispy-forms": ("crispy_forms",),
    "django-debug-toolbar": ("debug_toolbar",),
    "django-environ": ("environ",),
    "django-extensions": ("django_extensions",),
    "django-filter": ("django_filters",),
    "django-redis": ("django_redis",),
    "django-storages": ("storages",),
    "djangorestframework": ("rest_framework",),
    "djangorestframework-simplejwt": ("rest_framework_simplejwt",),
    "drf-spectacular": ("drf_spectacular",),
    "drf-yasg": ("drf_yasg",),
    "dnspython": ("dns",),
    "email-validator": ("email_validator",),
    "factory-boy": ("factory",),
    "faiss-cpu": ("faiss",),
    "flask-sqlalchemy": ("flask_sqlalchemy",),
    "google-api-python-client": ("googleapiclient",),
    "google-cloud-storage": ("google.cloud.storage",),
    "grpcio": ("grpc",),
    "grpcio-tools": ("grpc_tools",),
    "ipython": ("IPython",),
    "jinja2": ("jinja2",),
    "markdown": ("markdown",),
    "msgpack-python": ("msgpack",),
    "mysqlclient": ("MySQLdb",),
    "opencv-python": ("cv2",),
    "opencv-python-headless": ("cv2",),
    "opencv-contrib-python": ("cv2",),
    "paho-mqtt": ("paho",),
    "pillow": ("PIL",),
    "protobuf": ("google.protobuf",),
    "psycopg": ("psycopg",),
    "psycopg2-binary": ("psycopg2",),
    "pycryptodome": ("Crypto",),
    "pycryptodomex": ("Cryptodome",),
    "pygithub": ("github",),
    "pyjwt": ("jwt",),
    "pymongo": ("pymongo", "bson", "gridfs"),
    "pymupdf": ("fitz", "pymupdf"),
    "pyopenssl": ("OpenSSL",),
    "pyserial": ("serial",),
    "pytest-asyncio": ("pytest_asyncio",),
    "pytest-django": ("pytest_django",),
    "python-dateutil": ("dateutil",),
    "python-decouple": ("decouple",),
    "python-docx": ("docx",),
    "python-dotenv": ("dotenv",),
    "python-jose": ("jose",),
    "python-magic": ("magic",),
    "python-multipart": ("multipart", "python_multipart"),
    "python-slugify": ("slugify",),
    "python-telegram-bot": ("telegram",),
    "pytz": ("pytz",),
    "pywin32": ("win32api", "win32con", "win32com", "pywintypes"),
    "pyyaml": ("yaml",),
    "pyzmq": ("zmq",),
    "scikit-image": ("skimage",),
    "scikit-learn": ("sklearn",),
    "setuptools": ("setuptools", "pkg_resources"),
    "sentry-sdk": ("sentry_sdk",),
    "typing-extensions": ("typing_extensions",),
    "uvicorn": ("uvicorn",),
    "websocket-client": ("websocket",),
}

# The other way: the distribution an import most likely comes from, for imports nothing declares.
KNOWN_DISTRIBUTION: dict[str, str] = {}
for _dist, _names in IMPORT_NAMES.items():
    for _name in _names:
        KNOWN_DISTRIBUTION.setdefault(_name, _dist)


def import_names(distribution: str) -> tuple[str, ...]:
    """The modules a distribution is imported as: top-level names, or dotted ones in a shared namespace (google.protobuf)."""
    key = normalize(distribution)
    return IMPORT_NAMES.get(key) or (key.replace("-", "_"),)


def distribution_of(module: str, declared: dict[str, str]) -> str:
    """The distribution an imported module comes from: what the project declares, else what is known, else its top-level name.

    `declared` maps import names (from import_names) to the distribution names as the project writes them.
    """
    parts = module.split(".")
    for table in (declared, KNOWN_DISTRIBUTION):
        for size in range(len(parts), 0, -1):
            found = table.get(".".join(parts[:size]))
            if found:
                return found
    return parts[0]
