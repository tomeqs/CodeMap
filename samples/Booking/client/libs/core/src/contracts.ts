/** Mirrors server/src/Booking.Contracts/Dto/ReservationDto.cs. */
export interface ReservationDto {
  id: string;
  room: string;
  guest: string;
  nights: number;
  status: 'Pending' | 'Confirmed' | 'Cancelled';
}

export interface CreateReservationRequest {
  room: string;
  guest: string;
  nights: number;
}
