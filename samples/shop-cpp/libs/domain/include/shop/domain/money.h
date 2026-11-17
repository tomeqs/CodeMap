#pragma once
#include <cstdint>

namespace shop::domain {

/// An amount of money in cents.
class Money {
public:
    explicit Money(std::int64_t cents = 0);

    std::int64_t cents() const;
    Money operator+(const Money& other) const;
    Money times(int quantity) const;

private:
    std::int64_t cents_;
};

}  // namespace shop::domain
