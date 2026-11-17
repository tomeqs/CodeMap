#pragma once
#include <string>
#include "shop/domain/money.h"

namespace shop::domain {

/// A product on sale.
struct Product {
    std::string sku;
    std::string name;
    Money price;
};

}  // namespace shop::domain
