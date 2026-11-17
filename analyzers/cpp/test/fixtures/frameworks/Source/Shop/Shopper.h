#pragma once
#include "UObject/Interface.h"
#include "Shopper.generated.h"

UINTERFACE(MinimalAPI, Blueprintable)
class UShopper : public UInterface
{
    GENERATED_BODY()
};

class SHOP_API IShopper
{
    GENERATED_BODY()
public:
    virtual void Buy(int32 Amount) = 0;
};
