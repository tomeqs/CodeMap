#pragma once
#include <QWidget>

class Counter : public QObject
{
    Q_OBJECT
    Q_PROPERTY(int value READ value WRITE setValue NOTIFY valueChanged)
public:
    int value() const;
    void setValue(int value);
    Q_INVOKABLE void reset();
signals:
    void valueChanged(int value);
private:
    int value_ = 0;
};

class CartWidget : public QWidget
{
    Q_OBJECT
public:
    explicit CartWidget(QWidget* parent = nullptr);
public slots:
    void refresh();
private slots:
    void onCounted(int value);
private:
    Counter* counter_;
};
