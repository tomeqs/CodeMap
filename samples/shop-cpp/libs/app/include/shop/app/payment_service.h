#pragma once
#include <memory>
#include <string>
#include "shop/app/ports.h"

namespace shop::app {

class OrderService;

/// Charges orders through the gateway; refunds look the order up again.
class PaymentService {
public:
    explicit PaymentService(std::unique_ptr<PaymentGateway> gateway);

    void attach(OrderService& orders);
    bool charge(domain::Order& order);
    bool refund(const std::string& orderId);

private:
    std::unique_ptr<PaymentGateway> gateway_;
    OrderService* orders_ = nullptr;
};

}  // namespace shop::app
