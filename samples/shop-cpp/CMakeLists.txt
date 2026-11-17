cmake_minimum_required(VERSION 3.20)
project(shop_cpp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)

add_subdirectory(libs/domain)
add_subdirectory(libs/app)
add_subdirectory(libs/infra)
add_subdirectory(apps/cli)
add_subdirectory(apps/qt)

if(BUILD_TESTING)
  add_subdirectory(tests)
endif()
