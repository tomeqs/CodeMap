#pragma once
#include <string>
#include "shop/app/ports.h"
#include "shop/domain/catalog.h"

namespace shop::app {

class PaymentService;

/// Places and pays orders.
class OrderService {
public:
    OrderService(OrderRepository& orders, PaymentService& payments);

    domain::Order& place(const std::string& id, const domain::Product& product, int quantity);
    bool pay(const std::string& id);
    domain::Order* find(const std::string& id);

private:
    OrderRepository& orders_;
    PaymentService& payments_;
};

}  // namespace shop::app
