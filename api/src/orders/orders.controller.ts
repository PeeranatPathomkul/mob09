import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrdersService } from './orders.service';

@Controller('api/v1/orders')
@UseGuards(JwtAuthGuard)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(@Req() req: any, @Body() dto: CreateOrderDto) {
    const { orderJobId, message } = await this.ordersService.createOrder(req.user.userId, dto);
    return { status: 'processing', orderJobId, message };
  }
}
