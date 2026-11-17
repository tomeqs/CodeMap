#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "KioskActor.generated.h"

/** A kiosk in the level that sells from its stock. */
UCLASS(Blueprintable)
class SHOPKIOSK_API AKioskActor : public AActor
{
    GENERATED_BODY()

public:
    UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Shop")
    int32 Stock = 10;

    UFUNCTION(BlueprintCallable, Category = "Shop")
    bool Sell(int32 Amount);

protected:
    virtual void BeginPlay() override;

private:
    void Restock();
};
