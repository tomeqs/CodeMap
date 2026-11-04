using Booking.Domain.Time;
using Booking.Infrastructure;
using Booking.Infrastructure.Time;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();
builder.Services.AddBooking();
builder.Services.AddSingleton<IClock, UtcClock>(); // registered after AddBooking() (in another file): this clock wins

var app = builder.Build();
app.MapControllers();
app.MapGet("/health", () => "ok");
app.Run();
