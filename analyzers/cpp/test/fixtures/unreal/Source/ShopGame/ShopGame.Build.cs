using UnrealBuildTool;

public class ShopGame : ModuleRules
{
    public ShopGame(ReadOnlyTargetRules Target) : base(Target)
    {
        PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine", "ShopCore" });
        PrivateDependencyModuleNames.Add("Slate");
    }
}
