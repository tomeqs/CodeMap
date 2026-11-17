#include <gtest/gtest.h>
#include "shop/order.h"

TEST(OrderTest, StartsEmpty) {
    shop::Order order(1);
    EXPECT_EQ(order.total(), 0);
}
