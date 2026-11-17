#pragma once
#include <vector>
#include "shop/product.h"

namespace shop {

class SHOP_API Order {
public:
    explicit Order(int id);
    /// Adds a line of a product.
    void addLine(const Product& product, int quantity = 1);
    void addLine(const Product& product, int quantity, double discount);
    long total() const;
    static Order* create();

private:
    struct Line {
        Product product;
        int quantity;
    };

    int id_;
    std::vector<Line> lines_;
};

}  // namespace shop
