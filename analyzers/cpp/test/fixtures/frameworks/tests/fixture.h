#pragma once
#include "../qt/cart.h"

class CounterTest : public ::testing::Test {
protected:
    void SetUp() override;
    Counter counter;
    int start() const { return 1; }
};
