from django.contrib import admin

from orders.models import Customer, Order


@admin.register(Order)
class OrderAdmin(admin.ModelAdmin):
    list_display = ["id", "customer", "status"]


admin.site.register(Customer)
