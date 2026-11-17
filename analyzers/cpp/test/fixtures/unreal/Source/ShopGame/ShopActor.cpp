#include "ShopActor.h"
#include "Ledger.h"

AShopActor::AShopActor()
{
    PrimaryActorTick.bCanEverTick = false;
}

void AShopActor::Restock(int32 Amount)
{
    if (Amount > 0)
    {
        Stock += Amount;
    }
}

void AShopActor::BeginPlay()
{
    Super::BeginPlay();
}
