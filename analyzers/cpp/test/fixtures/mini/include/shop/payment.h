#pragma once

namespace shop {

class PaymentGateway {
public:
    virtual ~PaymentGateway() = default;
    virtual bool charge(long cents) = 0;
};

}  // namespace shop
