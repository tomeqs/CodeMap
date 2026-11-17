#include "shop/app/payment_service.h"
#include "shop/app/order_service.h"

namespace shop::app {

PaymentService::PaymentService(std::unique_ptr<PaymentGateway> gateway) : gateway_(std::move(gateway)) {}

void PaymentService::attach(OrderService& orders) { orders_ = &orders; }

bool PaymentService::charge(domain::Order& order) {
    return gateway_->charge(order.id(), order.total());
}

bool PaymentService::refund(const std::string& orderId) {
    domain::Order* order = orders_->find(orderId);
    if (order == nullptr || order->status() != domain::OrderStatus::Paid) return false;
    gateway_->refund(orderId);
    order->markRefunded();
    return true;
}

}  // namespace shop::app
