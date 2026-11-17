#ifndef LEDGER_H
#define LEDGER_H

#ifdef __cplusplus
extern "C" {
#endif

/* The ledger of the old shop: entries and the balance, in cents. */
typedef struct ledger {
    int entries;
    long balance;
} ledger_t;

int ledger_post(ledger_t* ledger, int kind, long amount);

#ifdef __cplusplus
}
#endif

#endif
