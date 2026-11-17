#include "shop/order.h"

int main(int argc, char** argv) {
    shop::Order* order = shop::Order::create();
    return argc > 1 ? 0 : static_cast<int>(order->total());
}
