#include "pay/service.h"

using pay::Receipt;

namespace pay {

PaymentService::PaymentService(std::unique_ptr<Gateway> gateway, detail::Ledger* ledger)
    : gateway_(std::move(gateway)), ledger_(ledger) {}

Receipt PaymentService::pay(long cents) {
    try {
        gateway_->charge(cents);
        ledger_->total += cents;
        if (ledger_->state == detail::Ledger::State::Closed) return last();
    } catch (const PaymentError& error) {
        return Receipt{};
    }

    auto receipt = last();
    receipt.amount();
    auto card = std::make_unique<CardGateway>();
    card->name();
    for (const auto& [id, kept] : receipts_) {
        kept.amount();
    }
    for (const auto& entry : history()) {
        entry.amount();
    }
    return receipt;
}

std::vector<Receipt> PaymentService::history() const { return {}; }

Receipt PaymentService::last() const { return receipts_.at(0); }

long Receipt::amount() const { return 0; }

PaymentService* PaymentService::instance() {
    static PaymentService* service = nullptr;
    return service;
}

}  // namespace pay
