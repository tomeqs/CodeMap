#include "checks.h"
#include <stdexcept>

Widget::Widget() {
    buffer_ = new int[16];
    single_ = new int(1);
    refresh();
    this->plain();
}

Widget::~Widget() {
    delete buffer_;
    delete single_;
}

void Widget::refresh() {}
void Widget::plain() {}

int unreachable(int x) {
    return x;
    x++;
}

int conditions(int a, int b, double ratio) {
    if (a = b) {
        return 1;
    }
    if ((a = b)) {
        return 2;
    }
    if (auto* p = &a) {
        return *p;
    }
    if (0) {
        return 3;
    }
    if constexpr (true) {
        b++;
    }
    while (1) {
        break;
    }
    if (a);
    {
        b++;
    }
    if (ratio == 0.5) {
        return 4;
    }
    if (ratio == 0) {
        return 5;
    }
    a = a;
    if (a == a) {
        return 6;
    }
    if (ratio != ratio) {
        return 7;
    }
    return a;
}

int cases(int kind) {
    int total = 0;
    switch (kind) {
    case 1:
        total += 1;
    case 2:
        total += 2;
        break;
    case 3:
    case 4:
        total += 4;
        [[fallthrough]];
    case 5:
        total += 5;
        // fall through
    case 6:
        if (total) { return 1; } else { return 2; }
    case 1:
        total = 9;
        break;
    default:
        total = 0;
    }
    return total;
}

void exceptions() {
    try {
        throw new std::runtime_error("boom");
    } catch (std::runtime_error error) {
    }

    try {
        std::runtime_error("lost");
        throw std::logic_error("kept");
    } catch (const std::exception& error) {
        throw;
    } catch (...) {
        // best effort
    }
}

void locking(std::mutex& m) {
    std::lock_guard<std::mutex>(m);
    std::lock_guard<std::mutex> held(m);
}

int* addresses() {
    int local = 1;
    static int kept = 2;
    if (local) return &kept;
    return &local;
}

const std::string& name() {
    std::string text = "x";
    return text;
}

void memory() {
    int* lost = new int(3);
    *lost = 4;
    int* kept = new int(5);
    delete kept;
    int* table = new int[4];
    delete table;
}

#define CHECKS_TRY try
#define CHECKS_CATCH(exception) catch(exception)
#define CHECKS_THROW(exception) throw exception

int macros(int kind) {
    CHECKS_TRY {
        switch (kind) {
        case 1:
            CHECKS_THROW(std::runtime_error("one"));
        case 2:
            return 2;
        }
    }
    CHECKS_CATCH(...) {}
    return 0;
}

bool exact(double k, float f, double d) {
    return floor(k) == k || d == (double)f || d == HUGE_VAL || d != -INFINITY;
}

int lexer(int c, int mode) {
    switch (c) {
    case 1:
        while (true) {
            if (mode) return 1;
        }
    case 2:
        switch (mode) {
        case 0: return 2;
        default: return 3;
        }
    case 3:
        while (true) {
            if (mode) break;
        }
    case 4:
        return 4;
    }
    return 0;
}

int attributed(int kind) {
    int total = 0;
    switch (kind) {
    case 1:
        total = 1;
        __attribute__((fallthrough));
    case 2:
        total = 2;
        break;
    }
    return total;
}

struct Label {
    int toString() { return 1; }
    int valueOf(int v) { return v; }
    int text() { return toString() + valueOf(3); }
};

class Deferred {
public:
    Deferred() {
        later([this] { update(); });
    }
    virtual ~Deferred() = default;
    virtual void update();
    template <typename F> void later(F f);
};

void handed_on() {
    int* job = new int(1);
    auto done = [job] { delete job; };
    done();
    int* owned = new int(2);
    std::unique_ptr<int> owner(owned);
}

typedef long HRESULT;
enum Code { Bad };
struct ShopError { int code; };

void caught() {
    try { exceptions(); } catch (HRESULT hr) { throw; }
    try { exceptions(); } catch (Code code) { throw; }
    try { exceptions(); } catch (ShopError error) { throw; }
    try { exceptions(); } catch (const ShopError& error) { throw; }
}

void caught_standard() {
    try { exceptions(); } catch (const std::out_of_range) { throw; }
}
