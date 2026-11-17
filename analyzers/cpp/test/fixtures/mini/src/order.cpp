#include "shop/order.h"
#include "shop/money.h"

namespace {

int clampQuantity(int quantity) {
    return quantity < 1 ? 1 : quantity;
}

}  // namespace

shop::Order::Order(int id) : id_(id) {}

void shop::Order::addLine(const Product& product, int quantity) {
    lines_.push_back({product, clampQuantity(quantity)});
}

using namespace shop;

void Order::addLine(const Product& product, int quantity, double discount) {
    if (discount > 0 && discount < 1) {
        lines_.push_back({product, quantity});
    }
}

long Order::total() const {
    long sum = 0;
    for (const auto& line : lines_) {
        sum = add(sum, line.product.price * line.quantity);
    }
    return sum;
}

Order* Order::create() {
    return new Order(0);
}
