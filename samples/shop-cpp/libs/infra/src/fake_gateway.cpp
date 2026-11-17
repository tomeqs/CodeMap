#include "shop/infra/fake_gateway.h"

namespace shop::infra {

bool FakePaymentGateway::charge(const std::string& orderId, const domain::Money& amount) {
    if (amount.cents() <= 0) return false;
    charged_.insert(orderId);
    return true;
}

void FakePaymentGateway::refund(const std::string& orderId) { charged_.erase(orderId); }

}  // namespace shop::infra
