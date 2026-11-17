#include <QtTest>
#include "../qt/cart.h"

class TestCart : public QObject
{
    Q_OBJECT
private slots:
    void refreshes();
};

void TestCart::refreshes()
{
    CartWidget widget;
    widget.refresh();
}

QTEST_MAIN(TestCart)
#include "qt_test.moc"
