#include "KioskActor.h"

bool AKioskActor::Sell(int32 Amount)
{
    if (Amount > Stock)
    {
        return false;
    }
    Stock -= Amount;
    if (Stock == 0)
    {
        Restock();
    }
    return true;
}

void AKioskActor::BeginPlay()
{
    Super::BeginPlay();
    Restock();
}

void AKioskActor::Restock() { Stock = 10; }
