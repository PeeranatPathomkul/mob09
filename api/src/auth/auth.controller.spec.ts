import { BadRequestException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let issueToken: jest.Mock;
  let controller: AuthController;

  beforeEach(() => {
    issueToken = jest.fn().mockReturnValue({ accessToken: 'signed.jwt.token' });
    controller = new AuthController({ issueToken } as unknown as AuthService);
  });

  it('returns the spec 2.1 shape for a valid userId', () => {
    expect(controller.token('user-999')).toEqual({
      status: 'success',
      accessToken: 'signed.jwt.token',
    });
    expect(issueToken).toHaveBeenCalledWith('user-999');
  });

  // The bug: `{}` used to answer 200 with a token carrying no `sub`, which
  // passed the guard and got a 202 out of POST /orders — an order that could
  // never succeed, since the worker's INSERT hit user_id NOT NULL.
  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace only', '   '],
    ['not a string', 12345],
  ])('rejects a %s userId with 400 and issues no token', (_label, value) => {
    expect(() => controller.token(value)).toThrow(BadRequestException);
    expect(issueToken).not.toHaveBeenCalled();
  });

  it('trims the userId so " user-1 " and "user-1" are the same subject', () => {
    controller.token('  user-1  ');
    expect(issueToken).toHaveBeenCalledWith('user-1');
  });
});
