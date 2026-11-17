find_package(Qt6 REQUIRED COMPONENTS Widgets)
qt_add_executable(shop_qt main.cpp cart_window.cpp)
target_link_libraries(shop_qt PRIVATE shop_app Qt6::Widgets)
