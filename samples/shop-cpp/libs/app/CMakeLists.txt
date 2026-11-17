add_library(shop_app
  src/order_service.cpp
  src/payment_service.cpp)
target_include_directories(shop_app PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>)
target_link_libraries(shop_app PUBLIC shop_domain)
