#pragma once
#include "shop/domain/money.h"

namespace shop::domain {

enum class Tier { Regular, Silver, Gold };

/// The discount a customer of a tier gets on an amount.
Money discountFor(Tier tier, const Money& amount);

}  // namespace shop::domain
