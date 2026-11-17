#pragma once
#include <set>
#include <string>
#include "shop/app/ports.h"

namespace shop::infra {

/// A gateway that accepts every payment and remembers it.
class FakePaymentGateway : public app::PaymentGateway {
public:
    bool charge(const std::string& orderId, const domain::Money& amount) override;
    void refund(const std::string& orderId) override;

private:
    std::set<std::string> charged_;
};

}  // namespace shop::infra
