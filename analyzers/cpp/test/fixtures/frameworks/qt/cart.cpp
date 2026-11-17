#include "cart.h"

int Counter::value() const { return value_; }

void Counter::setValue(int value)
{
    if (value != value_) {
        value_ = value;
        emit valueChanged(value);
    }
}

void Counter::reset() { setValue(0); }

CartWidget::CartWidget(QWidget* parent) : QWidget(parent), counter_(new Counter)
{
    connect(counter_, &Counter::valueChanged, this, &CartWidget::onCounted);
    connect(counter_, SIGNAL(valueChanged(int)), this, SLOT(refresh()));
}

void CartWidget::refresh() {}

void CartWidget::onCounted(int value) { refresh(); }
