cmake_minimum_required(VERSION 3.16)
project(mini CXX)

set(DOMAIN_SOURCES src/order.cpp src/money.cpp)
add_library(shop_domain ${DOMAIN_SOURCES})
target_include_directories(shop_domain PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>)

add_executable(shop_cli app/main.cpp)
target_link_libraries(shop_cli PRIVATE shop_domain fmt::fmt)

if(BUILD_TESTING)
  add_executable(shop_tests tests/order_test.cpp)
  target_link_libraries(shop_tests PRIVATE shop_domain GTest::gtest_main)
  add_test(NAME shop_tests COMMAND shop_tests)
endif()
