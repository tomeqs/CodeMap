#pragma once
#include <string>

namespace shop {

/// A product on sale. Prices are in cents.
struct Product {
    std::string name;
    long price = 0;
};

}  // namespace shop
