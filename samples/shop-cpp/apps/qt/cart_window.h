#pragma once
#include <QMainWindow>
#include "shop/domain/order.h"

class QLabel;

/// The cart: shows the order and its total.
class CartWindow : public QMainWindow
{
    Q_OBJECT
    Q_PROPERTY(int items READ items NOTIFY itemsChanged)

public:
    explicit CartWindow(QWidget* parent = nullptr);

    int items() const;
    void add(const shop::domain::Product& product);

signals:
    void itemsChanged(int items);

private slots:
    void refresh();

private:
    shop::domain::Order order_;
    QLabel* total_;
    int items_ = 0;
};
