#pragma once
#include <mutex>
#include <string>

using namespace std;

namespace adl {
using namespace std;
}

class Shape {
public:
    virtual double area() const = 0;
    ~Shape();
};

class Sealed final {
public:
    virtual void draw();
};

class Guarded {
public:
    virtual void run();
protected:
    ~Guarded();
};

class Widget {
public:
    Widget();
    ~Widget();
    virtual void refresh();
    void plain();
private:
    std::mutex mutex_;
    int* buffer_;
    int* single_;
};

using namespace std::chrono_literals;

UINTERFACE(MinimalAPI)
class UShopper : public UInterface {
    GENERATED_BODY()
};

class IShopper {
    GENERATED_BODY()
public:
    virtual void Buy();
};
