import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
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
  token(@Body('userId') userId: string) {
    const { accessToken } = this.authService.issueToken(userId);
    return { status: 'success', accessToken };
  }
}
