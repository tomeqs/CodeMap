#define BOOST_TEST_MODULE cart
#include <boost/test/unit_test.hpp>
#include "../qt/cart.h"

BOOST_AUTO_TEST_SUITE(counting)

BOOST_AUTO_TEST_CASE(counts_up)
{
    Counter counter;
    counter.setValue(5);
    BOOST_CHECK_EQUAL(counter.value(), 5);
}

BOOST_AUTO_TEST_SUITE_END()
