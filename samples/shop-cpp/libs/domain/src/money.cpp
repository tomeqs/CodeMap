#include "shop/domain/money.h"

namespace shop::domain {

Money::Money(std::int64_t cents) : cents_(cents) {}

std::int64_t Money::cents() const { return cents_; }

Money Money::operator+(const Money& other) const { return Money(cents_ + other.cents_); }

Money Money::times(int quantity) const { return Money(cents_ * quantity); }

}  // namespace shop::domain
