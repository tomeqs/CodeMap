using Booking.Domain.Reservations;
using Booking.Domain.Time;
using Booking.Infrastructure.Caching;
using Booking.Infrastructure.Notifications;
using Booking.Infrastructure.Persistence;
using Booking.Infrastructure.ReadModels;
using Booking.Infrastructure.Services;
using Booking.Infrastructure.Time;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Booking.Infrastructure;

public static class ServiceCollectionExtensions
{
    /// <summary>Every registration edge case the map has to read right; see samples/Booking/README.md.</summary>
    public static IServiceCollection AddBooking(this IServiceCollection services)
    {
        // TryAdd after Add: the container keeps SystemClock and ignores FixedClock.
        services.AddSingleton<IClock, SystemClock>();
        services.TryAddSingleton<IClock, FixedClock>();

        // The keyed Type overload: the key is "utc", not the service type.
        services.AddKeyedSingleton(typeof(IClock), "utc", typeof(UtcClock));

        // An enum key, and a keyed instance.
        services.AddKeyedSingleton<ICache, RedisCache>(CacheKind.Redis);
        services.AddKeyedSingleton<ICache>("memory", new MemoryCache());

        // An instance through typeof: EmailNotifier is built here, not by the container.
        services.AddSingleton(typeof(INotifier), new EmailNotifier());

        services.AddSingleton<IReservationRepository, InMemoryReservationRepository>();

        // A cast forward: registers the concrete store (not a second IReservationRepository), resolved through its interface.
        services.AddSingleton(sp => (InMemoryReservationRepository)sp.GetRequiredService<IReservationRepository>());

        // Closed generics: OccupancyReport asks for IReadModel<Reservation> and gets ReservationReadModel, not RoomNumbers.
        services.AddSingleton<IReadModel<Reservation>, ReservationReadModel>();
        services.AddScoped<IReadModel<string>, RoomNumbers>();
        services.AddSingleton<OccupancyReport>();

        // A fluent chain: each registration is on its own line.
        services
            .AddScoped<ReservationService>()
            .AddScoped<AvailabilityService>()
            .AddScoped<PricingService>();
        return services;
    }
}
