add_library(shop_infra
  src/memory_repository.cpp
  src/fake_gateway.cpp)
target_include_directories(shop_infra PUBLIC $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>)
target_link_libraries(shop_infra PUBLIC shop_app)
