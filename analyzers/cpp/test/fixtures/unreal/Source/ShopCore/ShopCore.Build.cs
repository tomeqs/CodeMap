using UnrealBuildTool;
public class ShopCore : ModuleRules
{
    public ShopCore(ReadOnlyTargetRules Target) : base(Target)
    {
        PublicDependencyModuleNames.AddRange(new string[] { "Core" });
    }
}
