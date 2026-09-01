import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

// Gap group 3 — PAGINATION & RESPONSE CONTRACT (spec 2.2).
//
//   k6 run -e BASE_URL=http://localhost:8080 load-test/pagination-integrity.js
//   docker compose --profile loadtest run --rm \
//     -e BASE_URL=http://172.30.58.13:8080 k6 /scripts/pagination-integrity.js
//
// products-read.js proves the read path is FAST. It does not prove it is
// CORRECT: it only ever asserts that `data` is an array and `meta.totalPages`
// exists. A system that returns page 1 for every page number, or drops the
// last row of every page, or omits `price`, passes it at 1,000 VUs.
//
// This script asserts what the spec's example response actually promises, and
// asserts it while the endpoint is under load — because the interesting
// pagination bugs are cache bugs, and a cache only misbehaves when several
// page/limit keys are live at once.
//
//   contract   1 VU, deep single-pass checks: meta arithmetic, page
//              disjointness, cross-limit agreement, field types, out-of-range
//   load       LOAD_VUS readers re-asserting the cheap per-response invariants
//              on every single response, for the whole run
//
// Nothing here assumes OUR implementation. `page`/`limit` clamping is this
// project's choice, not the spec's, so an out-of-range page is only required
// to answer 200 or 4xx — never 5xx, and never a wrong page. Where the spec is
// silent the result is REPORTED, not failed.

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
const LOAD_VUS = parseInt(__ENV.LOAD_VUS || '200', 10);
const LOAD_DUR = __ENV.LOAD_DUR || '30s';
const LIMIT = parseInt(__ENV.LIMIT || '10', 10);
// Limits the cross-check sweeps. 10 and 20 are the two the spec's own example
// implies are ordinary; a group that snaps limits to a menu still has to
// agree with itself across them.
const SWEEP_LIMITS = (__ENV.SWEEP_LIMITS || '10,20').split(',').map((n) => parseInt(n, 10));
// Hard ceiling on the crawl so a group with a huge catalogue — or a broken
// totalPages that never terminates — cannot hang the run.
const MAX_CRAWL_PAGES = parseInt(__ENV.MAX_CRAWL_PAGES || '50', 10);

// --- contract failures: every one of these is a spec break ----------------
const badMetaMath = new Counter('FAIL_meta_math');          // totalPages != ceil(total/limit)
const badMetaEcho = new Counter('FAIL_meta_echo');          // meta disagrees with the request AND with the rows returned
const badPageSize = new Counter('FAIL_page_size');          // data.length > limit
const dupAcrossPages = new Counter('FAIL_duplicate_across_pages'); // same productId on two pages
const missingFromCrawl = new Counter('FAIL_rows_lost');     // crawling every page yields fewer rows than meta.total
const badFieldShape = new Counter('FAIL_field_shape');      // a documented field missing or the wrong type
const badStockRange = new Counter('FAIL_stock_range');      // remainingStock < 0 or > availableStock
const crossLimitDisagree = new Counter('FAIL_cross_limit_disagreement'); // limit=10 and limit=20 describe different catalogues
const serverError = new Counter('FAIL_server_error');       // 5xx from the app
const badGateway = new Counter('INFRA_bad_gateway');        // 502/503/504 — nginx, not the app
const noConnection = new Counter('INFRA_no_connection');    // status 0, never reached the server

// --- observations: the spec does not mandate these, so they are reported ---
const outOfRangeRejected = new Counter('INFO_out_of_range_non_200');
const outOfRangeEmpty = new Counter('INFO_out_of_range_empty_200');

const crawlPages = new Trend('crawl_pages_walked');

// One sample line per distinct problem, so a systematic break does not print
// 200,000 identical lines and bury everything else.
const seen = {};
function sample(tag, detail) {
  if (seen[tag]) return;
  seen[tag] = true;
  console.error(`[${tag}] ${detail}`);
}

export const options = {
  scenarios: {
    contract: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      exec: 'contractPass',
      startTime: '0s',
      maxDuration: '180s',
    },
    // Starts a second later so the deep pass runs against a system that is
    // already busy: a page cache serving one key at a time hides the
    // cross-key mistakes this script exists to find.
    load: {
      executor: 'constant-vus',
      vus: LOAD_VUS,
      duration: LOAD_DUR,
      exec: 'loadPass',
      startTime: '1s',
    },
  },
  thresholds: {
    FAIL_meta_math: ['count==0'],
    FAIL_meta_echo: ['count==0'],
    FAIL_page_size: ['count==0'],
    FAIL_duplicate_across_pages: ['count==0'],
    FAIL_rows_lost: ['count==0'],
    FAIL_field_shape: ['count==0'],
    FAIL_stock_range: ['count==0'],
    FAIL_cross_limit_disagreement: ['count==0'],
    FAIL_server_error: ['count==0'],
    'http_req_duration{scenario:load}': ['p(95)<500'],
    'http_req_failed{scenario:load}': ['rate<0.01'],
  },
};

function get(page, limit, tag) {
  return http.get(`${BASE_URL}/api/v1/products?page=${page}&limit=${limit}`, {
    tags: { name: tag || 'products' },
  });
}

/** Classify a non-200 so a rig problem can never be read as a spec break. */
function recordTransport(res) {
  if (res.status === 0) {
    noConnection.add(1);
    sample('no_connection', `error_code=${res.error_code} ${res.error}`);
    return false;
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    badGateway.add(1);
    sample('bad_gateway', `status=${res.status} — nginx could not reach an upstream`);
    return false;
  }
  if (res.status >= 500) {
    serverError.add(1);
    sample('server_error', `status=${res.status} body=${String(res.body).slice(0, 200)}`);
    return false;
  }
  return res.status === 200;
}

function parse(res) {
  try {
    const b = res.json();
    return b && Array.isArray(b.data) && b.meta ? b : null;
  } catch (e) {
    return null;
  }
}

/**
 * Per-response invariants — cheap enough to run on every one of the load
 * scenario's responses, which is the point: a page cache that serves the
 * wrong key does it intermittently, under contention, not on a quiet probe.
 *
 * `askedPage`/`askedLimit` are what we requested. meta is allowed to differ
 * from them (a group may clamp, which the spec neither requires nor forbids),
 * but then the ROWS must match what meta itself says — "meta.limit is 20" and
 * "21 rows came back" cannot both be right under anyone's clamping rules.
 */
function checkResponseInvariants(body, askedPage, askedLimit, where) {
  const m = body.meta;
  let ok = true;

  if (body.status !== 'success') {
    badFieldShape.add(1);
    sample(`${where}_status_field`, `status=${JSON.stringify(body.status)} — spec 2.2 says "success"`);
    ok = false;
  }

  const total = m.total;
  const limit = m.limit;
  const page = m.page;

  if (!Number.isInteger(total) || !Number.isInteger(limit) || !Number.isInteger(page)) {
    badFieldShape.add(1);
    sample(`${where}_meta_types`, `meta=${JSON.stringify(m)} — total/page/limit must be integers`);
    return false;
  }

  // The arithmetic the spec's own example demonstrates: total 20, limit 10 ->
  // totalPages 2. A totalPages that is not derivable from total and limit is
  // the most common way a hand-rolled pagination goes wrong, and the client
  // that trusts it stops paging early.
  if (total > 0) {
    const expectedPages = Math.ceil(total / limit);
    if (m.totalPages !== expectedPages) {
      badMetaMath.add(1);
      sample(
        `${where}_meta_math`,
        `total=${total} limit=${limit} -> expected totalPages=${expectedPages}, got ${m.totalPages}`,
      );
      ok = false;
    }
  }

  // Rows must never exceed the page size the response itself claims.
  if (body.data.length > limit) {
    badPageSize.add(1);
    sample(`${where}_page_size`, `meta.limit=${limit} but data.length=${body.data.length}`);
    ok = false;
  }

  // A page is only allowed to be short if it is the last one.
  if (page < m.totalPages && body.data.length !== limit) {
    badMetaEcho.add(1);
    sample(
      `${where}_short_page`,
      `page ${page}/${m.totalPages} returned ${body.data.length} rows at limit=${limit} — only the last page may be short`,
    );
    ok = false;
  }

  // Clamping an out-of-range page is allowed; silently answering a DIFFERENT
  // in-range page is not.
  if (askedPage <= m.totalPages && page !== askedPage) {
    badMetaEcho.add(1);
    sample(`${where}_page_echo`, `asked page=${askedPage} (within ${m.totalPages}) but meta.page=${page}`);
    ok = false;
  }

  for (const p of body.data) {
    // Every field in the spec 2.2 example, with its type. A missing `price`
    // or a stringified number is exactly the break that only surfaces when
    // another group's client parses the response.
    const shapeOk =
      typeof p.productId === 'string' &&
      p.productId.length > 0 &&
      typeof p.name === 'string' &&
      typeof p.price === 'number' &&
      Number.isInteger(p.availableStock) &&
      Number.isInteger(p.remainingStock) &&
      typeof p.isFlashSaleActive === 'boolean';
    if (!shapeOk) {
      badFieldShape.add(1);
      sample(`${where}_item_shape`, `item=${JSON.stringify(p).slice(0, 250)}`);
      ok = false;
    }

    // remainingStock is the number the whole assignment turns on, so its
    // range is asserted on every response rather than once at the end.
    if (Number.isInteger(p.remainingStock) && Number.isInteger(p.availableStock)) {
      if (p.remainingStock < 0 || p.remainingStock > p.availableStock) {
        badStockRange.add(1);
        sample(
          `${where}_stock_range`,
          `${p.productId}: remainingStock=${p.remainingStock} availableStock=${p.availableStock}`,
        );
        ok = false;
      }
    }
  }

  return ok;
}

/** Walk every page at `limit`, returning the ids seen, or null if the walk broke. */
function crawl(limit) {
  const ids = [];
  const seenIds = new Set();
  let total = null;
  let pages = 1;

  for (let page = 1; page <= MAX_CRAWL_PAGES; page++) {
    const res = get(page, limit, 'crawl');
    if (!recordTransport(res)) return null;
    const body = parse(res);
    if (!body) {
      badFieldShape.add(1);
      sample('crawl_unparseable', `page=${page} limit=${limit} body=${String(res.body).slice(0, 200)}`);
      return null;
    }

    checkResponseInvariants(body, page, limit, 'crawl');
    total = body.meta.total;
    pages = body.meta.totalPages;

    for (const p of body.data) {
      // The bug this catches: a cache keyed without the page, or an OFFSET
      // computed from the wrong number, hands the same rows out twice — and
      // the user never sees the other half of the catalogue at all.
      if (seenIds.has(p.productId)) {
        dupAcrossPages.add(1);
        sample('crawl_duplicate', `${p.productId} appeared on more than one page at limit=${limit}`);
      }
      seenIds.add(p.productId);
      ids.push(p.productId);
    }

    crawlPages.add(page);
    if (page >= pages) break;
  }

  if (total !== null && seenIds.size !== total) {
    // Walking every page must yield exactly the catalogue meta claims. Fewer
    // means rows are unreachable through pagination; more means the total is
    // wrong. Either way a client cannot trust the endpoint.
    missingFromCrawl.add(1);
    sample(
      'crawl_row_count',
      `limit=${limit}: meta.total=${total} but walking ${pages} page(s) yielded ${seenIds.size} distinct products`,
    );
  }

  return { ids, unique: seenIds, total, pages };
}

export function contractPass() {
  console.log(`contract pass against ${BASE_URL}`);

  // ---- 1) crawl the whole catalogue at each sweep limit -------------------
  const crawls = {};
  for (const lim of SWEEP_LIMITS) {
    const c = crawl(lim);
    if (!c) {
      console.error(`crawl at limit=${lim} aborted — see the transport counters`);
      continue;
    }
    crawls[lim] = c;
    console.log(`limit=${lim}: ${c.pages} page(s), meta.total=${c.total}, ${c.unique.size} distinct products`);
  }

  // ---- 2) the catalogue must not depend on the page size ------------------
  // The same 20 products whether you read them 10 or 20 at a time. A cache
  // keyed without `limit`, or a LIMIT/OFFSET off-by-one, breaks exactly here
  // and nowhere else.
  const done = Object.keys(crawls).map(Number);
  let agree = true;
  for (let i = 1; i < done.length; i++) {
    const a = crawls[done[0]];
    const b = crawls[done[i]];
    if (a.total !== b.total) {
      crossLimitDisagree.add(1);
      agree = false;
      sample('cross_limit_total', `limit=${done[0]} says total=${a.total}, limit=${done[i]} says total=${b.total}`);
    }
    const onlyInA = [...a.unique].filter((id) => !b.unique.has(id));
    const onlyInB = [...b.unique].filter((id) => !a.unique.has(id));
    if (onlyInA.length || onlyInB.length) {
      crossLimitDisagree.add(1);
      agree = false;
      sample(
        'cross_limit_set',
        `limit=${done[0]} vs limit=${done[i]}: only in the first [${onlyInA.slice(0, 5)}], only in the second [${onlyInB.slice(0, 5)}]`,
      );
    }
  }
  check(null, { 'catalogue is identical across page sizes': () => agree });

  // ---- 3) page 1 and page 2 are genuinely different -----------------------
  // Asserted directly rather than inferred from the crawl: an implementation
  // that ignores `page` entirely still passes everything above whenever the
  // catalogue happens to fit on a single page.
  const base = crawls[SWEEP_LIMITS[0]];
  if (base && base.pages >= 2) {
    const p1 = parse(get(1, SWEEP_LIMITS[0], 'page_distinct'));
    const p2 = parse(get(2, SWEEP_LIMITS[0], 'page_distinct'));
    const distinct =
      !!p1 && !!p2 && p1.data.length > 0 && p2.data.length > 0 &&
      p1.data.every((a) => !p2.data.some((b) => b.productId === a.productId));
    if (!distinct) {
      dupAcrossPages.add(1);
      sample('page_1_vs_2', 'page 1 and page 2 share at least one product');
    }
    check(null, { 'page 1 and page 2 return different products': () => distinct });
  } else {
    console.log('catalogue fits on one page — skipping the page-1-vs-page-2 check');
  }

  // ---- 4) past the end of the catalogue -----------------------------------
  // The spec does not say what this must do, so neither answer fails the run.
  // What it must not do is 5xx, and if it answers 200 the page has to be
  // empty (or the clamped last page) — never a silent copy of page 1.
  const beyond = (base ? base.pages : 1) + 5;
  const farRes = get(beyond, SWEEP_LIMITS[0], 'out_of_range');
  if (farRes.status === 200) {
    const body = parse(farRes);
    if (body) {
      const empty = body.data.length === 0;
      const clampedToLast = body.meta.page === body.meta.totalPages;
      if (empty) outOfRangeEmpty.add(1);
      console.log(
        `page=${beyond}: 200 with ${body.data.length} row(s), meta.page=${body.meta.page} — ` +
          (empty ? 'empty page' : clampedToLast ? 'clamped to the last page' : 'UNEXPECTED: rows from an out-of-range page'),
      );
      if (!empty && !clampedToLast) {
        badMetaEcho.add(1);
        sample('out_of_range_rows', `page=${beyond} returned rows without clamping meta.page`);
      }
    }
  } else if (farRes.status >= 500) {
    recordTransport(farRes);
  } else {
    outOfRangeRejected.add(1);
    console.log(`page=${beyond}: answered ${farRes.status} — rejects out-of-range instead of clamping (allowed)`);
  }

  // ---- 5) unparseable input must not 5xx ----------------------------------
  // 200 (clamped), 400 and 422 are all defensible; a 500 means the query
  // string reached something that could not cope with it.
  for (const q of ['page=abc&limit=10', 'page=1&limit=abc', 'page=-1&limit=10', 'page=1&limit=0']) {
    const res = http.get(`${BASE_URL}/api/v1/products?${q}`, {
      responseCallback: http.expectedStatuses(200, 400, 422),
      tags: { name: 'malformed' },
    });
    if (res.status >= 500) recordTransport(res);
    check(res, { 'malformed query does not 5xx': () => res.status < 500 });
    console.log(`?${q} -> ${res.status}`);
  }
}

export function loadPass() {
  // Two pages, alternating, so at least two cache keys are live at once —
  // the condition under which a key collision actually shows itself.
  const page = ((__ITER + __VU) % 2) + 1;
  const res = get(page, LIMIT, 'load');
  if (!recordTransport(res)) {
    check(res, { 'load: 200 OK': () => false });
    return;
  }
  const body = parse(res);
  if (!body) {
    badFieldShape.add(1);
    sample('load_unparseable', String(res.body).slice(0, 200));
    check(res, { 'load: body parses': () => false });
    return;
  }
  const ok = checkResponseInvariants(body, page, LIMIT, 'load');
  check(res, { 'load: 200 OK': () => true, 'load: response invariants hold': () => ok });
}

export function handleSummary(data) {
  const out = __ENV.OUT || 'load-test/results/pagination-integrity.json';
  const m = data.metrics;
  const g = (n) => (m[n] && m[n].values.count !== undefined ? m[n].values.count : 0);

  const fails = [
    ['meta arithmetic (totalPages)', 'FAIL_meta_math'],
    ['meta echoes the wrong page', 'FAIL_meta_echo'],
    ['page returned more rows than limit', 'FAIL_page_size'],
    ['same product on two pages', 'FAIL_duplicate_across_pages'],
    ['rows unreachable by paging', 'FAIL_rows_lost'],
    ['field missing / wrong type', 'FAIL_field_shape'],
    ['remainingStock out of range', 'FAIL_stock_range'],
    ['catalogue differs across page sizes', 'FAIL_cross_limit_disagreement'],
    ['app 5xx', 'FAIL_server_error'],
  ];

  const lines = ['', '=== pagination & response contract (spec 2.2) ==='];
  let broken = 0;
  for (const [label, metric] of fails) {
    const c = g(metric);
    if (c > 0) broken++;
    lines.push(`  ${c === 0 ? 'PASS' : 'FAIL'}  ${label.padEnd(38)} ${c}`);
  }
  lines.push('');
  lines.push(`  rig, not the system: bad_gateway=${g('INFRA_bad_gateway')} no_connection=${g('INFRA_no_connection')}`);
  lines.push(
    `  out-of-range page: ${g('INFO_out_of_range_empty_200')} empty-200 / ${g('INFO_out_of_range_non_200')} rejected ` +
      '— spec is silent, reported not judged',
  );
  lines.push(
    broken === 0
      ? '  -> contract holds, including under concurrent read load'
      : `  -> ${broken} contract break(s); the [tag] lines above name each one once`,
  );
  lines.push('');

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) + lines.join('\n'),
    [out]: JSON.stringify(data, null, 2),
  };
}
