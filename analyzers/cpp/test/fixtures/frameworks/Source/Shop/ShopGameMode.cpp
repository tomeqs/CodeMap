#include "ShopGameMode.h"

void AShopGameMode::OpenShop() { Restock(); }

void AShopGameMode::OnSale_Implementation(int32 Discount) {}

void AShopGameMode::ServerBuy_Implementation(int32 Amount) { Buy(Amount); }

bool AShopGameMode::ServerBuy_Validate(int32 Amount) { return Amount > 0; }

void AShopGameMode::Buy(int32 Amount) {}

void AShopGameMode::Restock() {}

static TAutoConsoleVariable<bool> CVarShopDebug(TEXT("shop.debug"), false, TEXT("Draws the shop's debug shapes."), ECVF_Cheat);
