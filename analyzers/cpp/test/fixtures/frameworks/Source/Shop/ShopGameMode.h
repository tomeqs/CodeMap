#pragma once
#include "GameFramework/GameModeBase.h"
#include "Shopper.h"
#include "ShopGameMode.generated.h"

UCLASS()
class SHOP_API AShopGameMode : public AGameModeBase, public IShopper
{
    GENERATED_BODY()
public:
    UFUNCTION(BlueprintCallable, Category = "Shop")
    void OpenShop();

    UFUNCTION(BlueprintNativeEvent)
    void OnSale(int32 Discount);

    UFUNCTION(Server, Reliable, WithValidation)
    void ServerBuy(int32 Amount);

    void Buy(int32 Amount) override;

private:
    void Restock();
};
