import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

interface JwtPayload {
  sub?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // Stateless: token is verified against its signature only, no session/store lookup.
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET')!,
    });
  }

  validate(payload: JwtPayload) {
    // A validly signed token is not necessarily a usable one. `sub` was
    // optional in practice — AuthController used to sign `{ sub: undefined }`
    // for an empty body, and jwt.sign simply omits the claim — which arrived
    // here as `{ userId: undefined }` and flowed on into order handling,
    // producing keys like `order-lock:undefined:p-1001` shared by every
    // anonymous caller.
    //
    // The controller now rejects that at the source, but tokens minted before
    // this fix stay signature-valid for the rest of their hour, so the check
    // belongs here too rather than only there.
    if (typeof payload.sub !== 'string' || payload.sub.trim() === '') {
      throw new UnauthorizedException('token is missing a subject');
    }
    return { userId: payload.sub };
  }
}
