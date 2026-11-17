#include <gtest/gtest.h>
#include "fixture.h"

void CounterTest::SetUp() { counter.reset(); }

TEST(Counter, StartsAtZero) {
    Counter counter;
    EXPECT_EQ(counter.value(), 0);
}

TEST_F(CounterTest, Counts) {
    counter.setValue(start());
    EXPECT_EQ(counter.value(), 1);
}
