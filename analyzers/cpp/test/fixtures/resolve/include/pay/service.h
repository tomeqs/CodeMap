#pragma once
#include <map>
#include <memory>
#include <vector>
#include "pay/gateway.h"

namespace pay {

class Receipt {
public:
    long amount() const;
};

class PaymentService {
public:
    PaymentService(std::unique_ptr<Gateway> gateway, detail::Ledger* ledger);
    Receipt pay(long cents);
    std::vector<Receipt> history() const;
    static PaymentService* instance();

private:
    std::unique_ptr<Gateway> gateway_;
    std::map<int, Receipt> receipts_;
    detail::Ledger* ledger_;
    Receipt last() const;
};

}  // namespace pay
