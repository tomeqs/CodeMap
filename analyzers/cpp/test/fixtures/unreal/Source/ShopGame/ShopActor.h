#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "ShopActor.generated.h"

/** A shop placed in the level. */
UCLASS(Blueprintable)
class SHOPGAME_API AShopActor : public AActor
{
    GENERATED_BODY()

public:
    AShopActor();

    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Shop")
    int32 Stock = 0;

    UFUNCTION(BlueprintCallable, Category = "Shop")
    void Restock(int32 Amount);

protected:
    virtual void BeginPlay() override;
};
