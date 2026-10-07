using Shop.Api;
using Shop.Infrastructure;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddShop();
builder.Services.AddSingleton<RequestTimingMiddleware>();

var app = builder.Build();
app.UseMiddleware<RequestTimingMiddleware>();
app.MapControllers();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.Run();

public partial class Program;
