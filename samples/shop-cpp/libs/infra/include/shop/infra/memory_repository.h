#pragma once
#include <map>
#include <string>
#include "shop/app/ports.h"

namespace shop::infra {

/// Orders kept in memory, for the command line and the tests.
class InMemoryOrderRepository : public app::OrderRepository {
public:
    domain::Order* find(const std::string& id) override;
    void save(const domain::Order& order) override;

private:
    std::map<std::string, domain::Order> orders_;
};

}  // namespace shop::infra
