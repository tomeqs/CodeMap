#include <catch2/catch_test_macros.hpp>
#include "../qt/cart.h"

TEST_CASE("counter resets", "[counter]") {
    Counter counter;
    SECTION("after a change") {
        counter.setValue(3);
        counter.reset();
        REQUIRE(counter.value() == 0);
    }
}

TEST_SUITE("doctest suite") {
    TEST_CASE("counter counts") {
        Counter counter;
        counter.setValue(2);
    }
}

TEST_CASE_TEMPLATE("counter holds any number", T, int32_t, uint64_t) // NOLINT
{
    Counter counter;
    counter.setValue(1);
}

TEST_CASE("counter after a typed test") {
    Counter counter;
    counter.reset();
}
