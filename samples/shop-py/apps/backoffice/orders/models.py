from django.db import models


class Customer(models.Model):
    name = models.CharField(max_length=100)
    email = models.EmailField(unique=True)


class Order(models.Model):
    customer = models.ForeignKey(Customer, on_delete=models.CASCADE, related_name="orders")
    status = models.CharField(max_length=20, default="new")
    created = models.DateTimeField(auto_now_add=True)

    def close(self) -> None:
        self.status = "closed"
        self.save()


class OrderLine(models.Model):
    order = models.ForeignKey("Order", on_delete=models.CASCADE, related_name="lines")
    sku = models.CharField(max_length=40)
    quantity = models.PositiveIntegerField(default=1)
