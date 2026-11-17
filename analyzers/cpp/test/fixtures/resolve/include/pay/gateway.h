#pragma once
#include <memory>
#include <string>

namespace pay {

class PaymentError {
public:
    explicit PaymentError(const std::string& reason);
};

/// Charges money somewhere.
class Gateway {
public:
    virtual ~Gateway() = default;
    virtual bool charge(long cents) = 0;
    virtual std::string name() const = 0;
};

class Audited {
public:
    virtual void audit(int level);
    void note(const char* text);
    void note(double amount);
    void note(int code, int detail);
};

class CardGateway : public Gateway, public Audited {
public:
    bool charge(long cents) override;
    std::string name() const override;
    void audit(int level) override;
};

namespace detail {
struct Ledger {
    long total = 0;
    enum class State { Open, Closed };
    State state = State::Open;
};
}  // namespace detail

}  // namespace pay
