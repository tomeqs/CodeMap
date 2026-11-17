#include <gtest/gtest.h>
#include "shop/domain/order.h"

class OrderTest : public ::testing::Test {
protected:
    shop::domain::Product book{"B-1", "A book", shop::domain::Money(1000)};
    shop::domain::Order order{"A-1"};
};

TEST_F(OrderTest, AddsTheSameProductToOneLine) {
    order.addLine(book);
    order.addLine(book, 2);
    EXPECT_EQ(order.total().cents(), 3000);
}

TEST(Order, StartsOpen) {
    shop::domain::Order order("A-2");
    EXPECT_EQ(order.status(), shop::domain::OrderStatus::Open);
}
