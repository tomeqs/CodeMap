#include <iostream>
#include <memory>
#include "shop/app/order_service.h"
#include "shop/app/payment_service.h"
#include "shop/domain/discounts.h"
#include "shop/infra/fake_gateway.h"
#include "shop/infra/memory_repository.h"

using namespace shop;

int main(int argc, char** argv) {
    infra::InMemoryOrderRepository repository;
    app::PaymentService payments(std::make_unique<infra::FakePaymentGateway>());
    app::OrderService orders(repository, payments);

    domain::Product book{"B-1", "A book", domain::Money(1999)};
    domain::Order& order = orders.place("A-1", book, argc);
    const bool paid = orders.pay(order.id());
    std::cout << (paid ? "paid " : "not paid ") << domain::discountFor(domain::Tier::Gold, order.total()).cents() << "\n";
    if (argc > 2) payments.refund(order.id());
    return paid ? 0 : 1;
}
