import { HttpClient, type CreateReservationRequest, type ReservationDto } from '@booking/core';

/**
 * The C# Booking.Api over HTTP (server/src/Booking.Api/Controllers/ReservationsController.cs).
 * Edge case: super() calls the constructor of HttpClient in @booking/core, a package analyzed after this one.
 */
export class ReservationsApi extends HttpClient {
  constructor(baseUrl: string) {
    super(baseUrl);
  }

  list(): Promise<ReservationDto[]> {
    return this.get<ReservationDto[]>('/api/reservations');
  }

  create(request: CreateReservationRequest): Promise<ReservationDto> {
    return this.post<ReservationDto>('/api/reservations', request);
  }

  cancel(id: string): Promise<void> {
    return this.delete(`/api/reservations/${id}`);
  }
}
