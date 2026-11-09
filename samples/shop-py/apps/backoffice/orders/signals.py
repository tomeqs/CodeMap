from django.db.models.signals import post_save
from django.dispatch import receiver

from orders.models import Order


@receiver(post_save, sender=Order)
def order_saved(sender, instance, created, **kwargs):
    if created:
        print(f"order {instance.id} created")
