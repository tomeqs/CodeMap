#pragma once
#include <string>
#include <vector>
#include "shop/domain/catalog.h"
#include "shop/domain/money.h"

namespace shop::domain {

enum class OrderStatus { Open, Paid, Refunded };

/// An order of a customer: lines of products, paid once.
class Order {
public:
    explicit Order(std::string id);

    const std::string& id() const;
    OrderStatus status() const;

    /// One more of a product.
    void addLine(const Product& product);
    void addLine(const Product& product, int quantity);

    Money total() const;
    void markPaid();
    void markRefunded();

private:
    struct Line {
        Product product;
        int quantity;
    };

    Money legacyTotal() const;

    std::string id_;
    OrderStatus status_ = OrderStatus::Open;
    std::vector<Line> lines_;
};

}  // namespace shop::domain
