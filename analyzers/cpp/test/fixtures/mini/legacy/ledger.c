#include "ledger.h"

static long clamp(long amount) {
    if (amount < 0) return 0;
    return amount;
}

int ledger_add(ledger_t* ledger, long amount) {
    ledger->balance += clamp(amount);
    return ++ledger->entries;
}
