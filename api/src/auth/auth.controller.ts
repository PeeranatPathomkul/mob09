import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('token')
  // Spec 2.1 defines this as "Response (200 OK)". Nest answers 201 by default
  // on @Post, which is fine REST-wise but breaks any load-test script that
  // checks the documented status — and the whole point of the shared spec is
  // that one group's script runs against another group's system.
  @HttpCode(HttpStatus.OK)
  token(@Body('userId') userId: unknown) {
    // Without this, a body of `{}` still answered 200 with a signed token
    // whose payload had no `sub` (jwt.sign drops undefined claims). That
    // token passed the guard, and POST /orders accepted the order and
    // answered 202 — promising a queued order that could never succeed: the
    // worker only found out at the INSERT, where user_id NOT NULL rejected
    // it. Postgres was the sole thing standing between an anonymous caller
    // and a confirmed order.
    //
    // Rejecting here rather than at the guard keeps the failure at the point
    // the caller can act on: they get 400 "userId is required" instead of a
    // token that mysteriously stops working one request later.
    if (typeof userId !== 'string' || userId.trim() === '') {
      throw new BadRequestException('userId is required');
    }

    const { accessToken } = this.authService.issueToken(userId.trim());
    return { status: 'success', accessToken };
  }
}
