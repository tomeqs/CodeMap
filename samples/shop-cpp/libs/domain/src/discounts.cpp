#include "shop/domain/discounts.h"

namespace shop::domain {

Money discountFor(Tier tier, const Money& amount) {
    std::int64_t percent = 0;
    switch (tier) {
    case Tier::Gold:
        percent += 5;
    case Tier::Silver:
        percent += 5;
        break;
    case Tier::Regular:
        break;
    }
    return Money(amount.cents() * percent / 100);
}

}  // namespace shop::domain
