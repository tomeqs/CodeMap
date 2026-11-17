#include "shop/money.h"

namespace shop {

long roundCents(double value) {
    return static_cast<long>(value + 0.5);
}

long add(long a, long b) {
    return a + b;
}

}  // namespace shop
