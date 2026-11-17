using UnrealBuildTool;

public class ShopKiosk : ModuleRules
{
    public ShopKiosk(ReadOnlyTargetRules Target) : base(Target)
    {
        PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });
    }
}
