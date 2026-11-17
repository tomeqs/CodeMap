#include "shop/domain/order.h"
#include <utility>

namespace shop::domain {

namespace {

/// Prices are kept in whole cents: half a cent rounds up.
std::int64_t roundCents(std::int64_t tenthsOfCents) {
    return (tenthsOfCents + 5) / 10;
}

}  // namespace

Order::Order(std::string id) : id_(std::move(id)) {}

const std::string& Order::id() const { return id_; }

OrderStatus Order::status() const { return status_; }

void Order::addLine(const Product& product) { addLine(product, 1); }

void Order::addLine(const Product& product, int quantity) {
    for (auto& line : lines_) {
        if (line.product.sku == product.sku) {
            line.quantity += quantity;
            return;
        }
    }
    lines_.push_back(Line{product, quantity});
}

Money Order::total() const {
    Money sum;
    for (const auto& line : lines_) {
        sum = sum + line.product.price.times(line.quantity);
    }
    return Money(roundCents(sum.cents() * 10));
}

void Order::markPaid() { status_ = OrderStatus::Paid; }

void Order::markRefunded() { status_ = OrderStatus::Refunded; }

Money Order::legacyTotal() const {
    Money sum;
    for (const auto& line : lines_) sum = sum + line.product.price;
    return sum;
}

}  // namespace shop::domain
