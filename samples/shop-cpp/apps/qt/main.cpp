#include <QApplication>
#include "cart_window.h"

int main(int argc, char* argv[])
{
    QApplication app(argc, argv);
    CartWindow window;
    window.add(shop::domain::Product{"B-1", "A book", shop::domain::Money(1999)});
    window.show();
    return app.exec();
}
