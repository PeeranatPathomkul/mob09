import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(private readonly jwtService: JwtService) {}

  // TODO: replace with real user lookup/credential check once user storage is defined.
  // For now this issues a token for any userId so downstream flows (orders, products) can be built stateless.
  issueToken(userId: string): { accessToken: string } {
    const accessToken = this.jwtService.sign({ sub: userId });
    return { accessToken };
  }
}
