import { IsNotEmpty, IsString } from 'class-validator';

// Per spec 2.3: clients only send productId. Quantity is never accepted
// from the request — each user may buy at most 1 unit, enforced
// server-side (see orders.service.ts / orders.processor.ts).
export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;
}