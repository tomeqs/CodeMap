add_library(shop_domain
  src/money.cpp
  src/order.cpp
  src/discounts.cpp)
target_include_directories(shop_domain PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>)
