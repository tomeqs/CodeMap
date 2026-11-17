#include "pay/gateway.h"

namespace pay {

PaymentError::PaymentError(const std::string& reason) {}

bool CardGateway::charge(long cents) {
    if (cents <= 0) {
        throw PaymentError("nothing to charge");
    }
    note("charged");
    note(1.5);
    note(1, 2);
    audit(1);
    return true;
}

std::string CardGateway::name() const { return "card"; }

void CardGateway::audit(int level) { Audited::audit(level); }

void Audited::audit(int level) {}
void Audited::note(const char* text) {}
void Audited::note(double amount) {}
void Audited::note(int code, int detail) {}

}  // namespace pay
