#include <catch2/catch_test_macros.hpp>
#include "shop/domain/discounts.h"

using namespace shop::domain;

TEST_CASE("gold customers get ten percent", "[discounts]") {
    REQUIRE(discountFor(Tier::Gold, Money(1000)).cents() == 100);
}
