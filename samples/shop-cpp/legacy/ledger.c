#include "ledger.h"

typedef long (*posting_fn)(long balance, long amount);

static long credit(long balance, long amount) { return balance + amount; }
static long debit(long balance, long amount) { return balance - amount; }

static const posting_fn postings[] = { credit, debit };

int ledger_post(ledger_t* ledger, int kind, long amount) {
    if (kind < 0 || kind > 1) return -1;
    ledger->balance = postings[kind](ledger->balance, amount);
    return ++ledger->entries;
}
