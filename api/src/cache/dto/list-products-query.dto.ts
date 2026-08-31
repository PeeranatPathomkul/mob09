import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/**
 * Upper bound on `page`, clamped rather than rejected.
 *
 * Every distinct page/limit pair becomes its own cache key
 * (`products:page:{page}:limit:{limit}:v:{version}`), so an unbounded `page`
 * means an unbounded key space: each new value is a guaranteed miss that the
 * rebuild lock cannot coalesce — nobody else is asking for that key — and it
 * leaves a fresh key in Redis for a full TTL. That is cache penetration, and
 * at load-test rates it grows Redis without limit while sending one query per
 * request straight to Postgres.
 *
 * Clamping instead of rejecting keeps the response a 200 for any in-range
 * number, which matters because the read load test counts non-2xx as failure
 * (`http_req_failed: rate<0.01`). The caller asked for a page past the end of
 * the catalog either way, so the empty page they get back is the honest
 * answer — meta.page reports the clamped value, not what they typed.
 *
 * 1,000 pages x the largest allowed limit is far more than this catalog will
 * hold, so the ceiling is invisible to real pagination while still making the
 * key space a number we can compute.
 */
export const MAX_PAGE = 1000;

/**
 * The only page sizes that ever reach the cache, ascending.
 *
 * `limit` multiplies the key space the same way `page` does: at 1-100 free
 * choice, one version bump can invalidate up to 100 separate key sets per
 * page, and a client picking 15 gets a key set nobody else will ever share.
 * Snapping to a short menu makes the whole key space a product of two small
 * numbers (MAX_PAGE x this list) instead of an open range.
 *
 * Values are rounded *up* to the next entry so a caller never silently gets
 * fewer rows than it asked for; anything above the largest entry lands on it.
 */
export const ALLOWED_LIMITS = [10, 20, 50, 100] as const;

const LARGEST_LIMIT = ALLOWED_LIMITS[ALLOWED_LIMITS.length - 1];

/** Round a requested page size up to the nearest allowed one. */
function snapLimit(requested: number): number {
  return ALLOWED_LIMITS.find((allowed) => allowed >= requested) ?? LARGEST_LIMIT;
}

export class ListProductsQueryDto {
  // Not @Type(() => Number): when both are present @Transform owns the value,
  // so the conversion has to happen here or it happens twice.
  @Transform(({ value }) => {
    if (value === undefined) return 1;
    const parsed = Number(value);
    // Leave NaN/Infinity alone — @IsInt below rejects them. Only a real,
    // finite number is something we can meaningfully clamp.
    return Number.isFinite(parsed) ? Math.min(parsed, MAX_PAGE) : parsed;
  })
  @IsInt()
  @Min(1)
  page: number = 1;

  @Transform(({ value }) => {
    if (value === undefined) return 10;
    const parsed = Number(value);
    // Below 1 is passed through untouched so @Min(1) still rejects it —
    // snapping 0 or -5 up to 10 would silently honour a nonsense request.
    // NaN/Infinity likewise fall through to @IsInt.
    if (!Number.isFinite(parsed) || parsed < 1) return parsed;
    return snapLimit(parsed);
  })
  @IsInt()
  @Min(1)
  // Unreachable now that every accepted value comes from ALLOWED_LIMITS, but
  // kept as an assertion: if the snapping is ever changed or removed, this is
  // what stops an unbounded page size from reaching Postgres.
  @Max(LARGEST_LIMIT)
  limit: number = 10;
}
