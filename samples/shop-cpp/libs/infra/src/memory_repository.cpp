#include "shop/infra/memory_repository.h"

namespace shop::infra {

domain::Order* InMemoryOrderRepository::find(const std::string& id) {
    auto it = orders_.find(id);
    return it == orders_.end() ? nullptr : &it->second;
}

void InMemoryOrderRepository::save(const domain::Order& order) {
    orders_.insert_or_assign(order.id(), order);
}

}  // namespace shop::infra
