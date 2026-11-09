from django.core.management.base import BaseCommand

from orders.models import Order


class Command(BaseCommand):
    help = "Closes orders nobody paid."

    def handle(self, *args, **options):
        for order in Order.objects.filter(status="new"):
            order.close()
