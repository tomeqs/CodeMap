#pragma once

class SHOPCORE_API FLedger
{
public:
    void Add(int32 Amount);
private:
    int32 Balance = 0;
};
