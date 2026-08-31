import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy.validate', () => {
  const strategy = new JwtStrategy({
    get: () => 'test-secret',
  } as unknown as ConfigService);

  it('maps sub to userId', () => {
    expect(strategy.validate({ sub: 'user-42' })).toEqual({ userId: 'user-42' });
  });

  // Second line of defence: the controller no longer mints these, but any
  // already handed out stay signature-valid until they expire.
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace only', '  '],
  ])('rejects a token whose sub is %s', (_label, sub) => {
    expect(() => strategy.validate({ sub })).toThrow(UnauthorizedException);
  });
});
