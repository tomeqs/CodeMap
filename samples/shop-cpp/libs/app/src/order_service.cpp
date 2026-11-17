#include "shop/app/order_service.h"
#include "shop/app/payment_service.h"

namespace shop::app {

OrderService::OrderService(OrderRepository& orders, PaymentService& payments)
    : orders_(orders), payments_(payments) {
    payments_.attach(*this);
}

domain::Order& OrderService::place(const std::string& id, const domain::Product& product, int quantity) {
    domain::Order order(id);
    order.addLine(product, quantity);
    orders_.save(order);
    return *orders_.find(id);
}

bool OrderService::pay(const std::string& id) {
    domain::Order* order = orders_.find(id);
    if (order == nullptr) return false;
    if (!payments_.charge(*order)) return false;
    order->markPaid();
    orders_.save(*order);
    return true;
}

domain::Order* OrderService::find(const std::string& id) { return orders_.find(id); }

}  // namespace shop::app
