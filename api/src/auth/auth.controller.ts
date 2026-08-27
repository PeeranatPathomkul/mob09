import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('token')
  token(@Body('userId') userId: string) {
    const { accessToken } = this.authService.issueToken(userId);
    return { status: 'success', accessToken };
  }
}
