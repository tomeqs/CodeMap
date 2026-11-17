#include <QApplication>
#include "cart.h"

int main(int argc, char* argv[])
{
    QApplication app(argc, argv);
    CartWidget widget;
    widget.show();
    return app.exec();
}
