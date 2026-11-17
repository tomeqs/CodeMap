#ifndef LEDGER_H
#define LEDGER_H

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ledger {
    int entries;
    long balance;
} ledger_t;

int ledger_add(ledger_t* ledger, long amount);

#ifdef __cplusplus
}
#endif

#endif
