SECRET_KEY = "not-a-secret"
DEBUG = True
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "rest_framework",
    "orders.apps.OrdersConfig",
]
MIDDLEWARE = [
    "django.middleware.common.CommonMiddleware",
    "orders.middleware.AuditMiddleware",
]
ROOT_URLCONF = "backoffice.urls"
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": "db.sqlite3"}}
