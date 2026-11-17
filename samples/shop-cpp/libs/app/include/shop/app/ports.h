#pragma once
#include <memory>
#include <string>
#include "shop/domain/money.h"
#include "shop/domain/order.h"

namespace shop::app {

/// Where orders are kept.
class OrderRepository {
public:
    virtual ~OrderRepository() = default;
    virtual domain::Order* find(const std::string& id) = 0;
    virtual void save(const domain::Order& order) = 0;
};

/// Takes money from a customer.
class PaymentGateway {
public:
    virtual ~PaymentGateway() = default;
    virtual bool charge(const std::string& orderId, const domain::Money& amount) = 0;
    virtual void refund(const std::string& orderId) = 0;
};

}  // namespace shop::app
