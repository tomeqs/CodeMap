cmake_minimum_required(VERSION 3.16)
project(resolve CXX)
add_library(pay src/gateway.cpp src/service.cpp src/callbacks.c)
target_include_directories(pay PUBLIC include)
