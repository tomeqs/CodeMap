from django.http import JsonResponse
from django.views import View
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from orders.models import Order
from orders.serializers import OrderSerializer


def order_list(request):
    return JsonResponse({"orders": [o.id for o in Order.objects.filter(status="new")]})


class OrderDetailView(View):
    def get(self, request, pk):
        order = Order.objects.get(pk=pk)
        return JsonResponse({"id": order.id, "status": order.status})

    def post(self, request, pk):
        Order.objects.get(pk=pk).close()
        return JsonResponse({"closed": True})


class OrderViewSet(viewsets.ModelViewSet):
    queryset = Order.objects.all()
    serializer_class = OrderSerializer

    @action(detail=True, methods=["post"])
    def close(self, request, pk=None):
        self.get_object().close()
        return Response({"closed": True})
