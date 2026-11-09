from django.urls import include, path
from rest_framework.routers import DefaultRouter

from orders import views

router = DefaultRouter()
router.register(r"api", views.OrderViewSet)

urlpatterns = [
    path("", views.order_list, name="order-list"),
    path("<int:pk>/", views.OrderDetailView.as_view(), name="order-detail"),
    path("", include(router.urls)),
]
