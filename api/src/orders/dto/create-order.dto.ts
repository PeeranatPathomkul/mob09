import { IsInt, IsNotEmpty, IsPositive, IsString } from 'class-validator';

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  productId: string;

  @IsInt()
  @IsPositive()
  quantity: number;
}
