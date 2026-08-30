import 'reflect-metadata'; // @Type()'s design:type metadata needs this loaded before the DTO class is defined
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ALLOWED_LIMITS,
  ListProductsQueryDto,
  MAX_PAGE,
} from './list-products-query.dto';

// Mirrors what the app's global ValidationPipe({ transform: true }) does to
// a raw query object, without spinning up the whole Nest app.
async function parseQuery(raw: Record<string, string>) {
  const dto = plainToInstance(ListProductsQueryDto, raw);
  const errors = await validate(dto);
  return { dto, errors };
}

describe('ListProductsQueryDto', () => {
  it('defaults page=1, limit=10 when neither is sent', async () => {
    const { dto, errors } = await parseQuery({});
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(10);
  });

  it('defaults limit=10 when only page is sent', async () => {
    const { dto, errors } = await parseQuery({ page: '2' });
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(10);
  });

  it('rejects page=0', async () => {
    const { errors } = await parseQuery({ page: '0' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-integer page', async () => {
    const { errors } = await parseQuery({ page: 'abc' });
    expect(errors.length).toBeGreaterThan(0);
  });

  // An unbounded page is a cache-penetration hole: every distinct value is a
  // guaranteed miss on a key nobody else is asking for, so the rebuild lock
  // has nothing to coalesce and each one parks a new key in Redis for a full
  // TTL. Clamping (rather than rejecting) keeps these 200s, which the read
  // load test's http_req_failed threshold cares about.
  it(`clamps a page above the max down to ${MAX_PAGE}`, async () => {
    const { dto, errors } = await parseQuery({ page: '847392' });
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(MAX_PAGE);
  });

  it('accepts the page at the max boundary unchanged', async () => {
    const { dto, errors } = await parseQuery({ page: String(MAX_PAGE) });
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(MAX_PAGE);
  });

  it('leaves a page below the max untouched', async () => {
    const { dto, errors } = await parseQuery({ page: '7' });
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(7);
  });

  // Clamping is upper-bound only: a page below 1 is not a number we can
  // honour, so @Min(1) still rejects it rather than silently meaning page 1.
  it('still rejects a negative page rather than clamping it up', async () => {
    const { errors } = await parseQuery({ page: '-5' });
    expect(errors.length).toBeGreaterThan(0);
  });

  // Was "rejects limit=1000": an out-of-range page size is now snapped to the
  // largest allowed one instead of 400ing, for the same reason `page` clamps.
  it('snaps limit=1000 down to the largest allowed limit', async () => {
    const { dto, errors } = await parseQuery({ limit: '1000' });
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(100);
  });

  it('accepts limit=100 (the boundary)', async () => {
    const { dto, errors } = await parseQuery({ limit: '100' });
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(100);
  });

  it('leaves a limit that is already allowed untouched', async () => {
    for (const allowed of ALLOWED_LIMITS) {
      const { dto, errors } = await parseQuery({ limit: String(allowed) });
      expect(errors).toHaveLength(0);
      expect(dto.limit).toBe(allowed);
    }
  });

  // Rounding up, so a caller never gets fewer rows than it asked for.
  it('rounds an in-between limit up to the next allowed one', async () => {
    const { dto, errors } = await parseQuery({ limit: '15' });
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(20);
  });

  it('snaps a limit below the smallest allowed one up to it', async () => {
    const { dto, errors } = await parseQuery({ limit: '3' });
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(10);
  });

  // Same upper-bound-only rule as `page`: nonsense input still fails rather
  // than being quietly reinterpreted as the smallest page size.
  it('still rejects limit=0 rather than snapping it up', async () => {
    const { errors } = await parseQuery({ limit: '0' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('still rejects a non-numeric limit', async () => {
    const { errors } = await parseQuery({ limit: 'abc' });
    expect(errors.length).toBeGreaterThan(0);
  });

  // The whole point of both clamps: the number of distinct cache keys a
  // client can create is now a product of two small constants.
  it('bounds the cache key space to MAX_PAGE x ALLOWED_LIMITS', async () => {
    const { dto } = await parseQuery({ page: '99999999', limit: '99999999' });
    expect(dto.page).toBe(MAX_PAGE);
    expect(ALLOWED_LIMITS).toContain(dto.limit as (typeof ALLOWED_LIMITS)[number]);
  });
});
