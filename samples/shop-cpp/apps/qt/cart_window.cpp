#include "cart_window.h"
#include <QLabel>

CartWindow::CartWindow(QWidget* parent) : QMainWindow(parent), order_("cart"), total_(new QLabel(this))
{
    setCentralWidget(total_);
    connect(this, &CartWindow::itemsChanged, this, &CartWindow::refresh);
}

int CartWindow::items() const { return items_; }

void CartWindow::add(const shop::domain::Product& product)
{
    order_.addLine(product);
    ++items_;
    emit itemsChanged(items_);
}

void CartWindow::refresh()
{
    total_->setText(QString::number(order_.total().cents() / 100.0, 'f', 2));
}
