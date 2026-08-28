import 'reflect-metadata'; // @Type()'s design:type metadata needs this loaded before the DTO class is defined
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListProductsQueryDto } from './list-products-query.dto';

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

  it('rejects limit=1000 (over the max of 100)', async () => {
    const { errors } = await parseQuery({ limit: '1000' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts limit=100 (the boundary)', async () => {
    const { errors } = await parseQuery({ limit: '100' });
    expect(errors).toHaveLength(0);
  });
});
