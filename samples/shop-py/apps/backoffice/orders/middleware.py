import logging

logger = logging.getLogger(__name__)


class AuditMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        logger.info("%s %s", request.method, request.path)
        return self.get_response(request)
