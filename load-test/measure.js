/**
 * Reads the finished jobs out of BullMQ and reports what actually happened.
 *
 *   node load-test/measure.js
 *   node load-test/measure.js --csv bench-results.csv --label "pessimistic/c10"
 *
 * Throughput is computed from min(processedOn) to max(finishedOn) — the window
 * in which the WORKER was busy. k6's wall clock is the wrong denominator: it
 * includes the time k6 spent producing requests, which makes a fast worker
 * look slow purely because the load generator was still ramping up.
 */
const { createRequire } = require('module');
const path = require('path');
const { appendFileSync, existsSync, writeFileSync } = require('fs');

// bullmq lives in api/node_modules, not here. createRequire resolves it from
// the api package so this script needs no node_modules of its own.
const apiRequire = createRequire(path.join(__dirname, '..', 'api', 'package.json'));
const { Queue } = apiRequire('bullmq');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const QUEUE_NAME = process.env.ORDERS_QUEUE || 'orders';
const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6379),
};

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** "OUT_OF_STOCK: no units left for p-1001" -> "OUT_OF_STOCK" */
function reasonLabel(failedReason) {
  if (!failedReason) return 'UNKNOWN';
  const match = failedReason.match(/^([A-Z_]+):/);
  return match ? match[1] : failedReason.slice(0, 40);
}

async function main() {
  const queue = new Queue(QUEUE_NAME, { connection });

  const completed = await queue.getJobs(['completed'], 0, -1);
  const failed = await queue.getJobs(['failed'], 0, -1);
  const all = [...completed, ...failed];

  if (!all.length) {
    console.log('no finished jobs found — did the load run, and was the queue reset?');
    await queue.close();
    return;
  }

  const starts = all.map((j) => j.processedOn || 0).filter(Boolean);
  const ends = all.map((j) => j.finishedOn || 0).filter(Boolean);
  const windowMs = Math.max(...ends) - Math.min(...starts);

  const durations = all
    .filter((j) => j.processedOn && j.finishedOn)
    .map((j) => j.finishedOn - j.processedOn)
    .sort((a, b) => a - b);

  const failureBreakdown = {};
  for (const j of failed) {
    const label = reasonLabel(j.failedReason);
    failureBreakdown[label] = (failureBreakdown[label] || 0) + 1;
  }

  const retried = all.filter((j) => (j.attemptsMade || 0) > 1).length;
  const jobsPerSec = windowMs > 0 ? (all.length / windowMs) * 1000 : 0;

  const report = {
    label: arg('label', ''),
    strategy: process.env.STOCK_CLAIM_STRATEGY || 'pessimistic',
    concurrency: Number(process.env.WORKER_CONCURRENCY || 10),
    poolMax: Number(process.env.DB_POOL_MAX || 12),
    total: all.length,
    completed: completed.length,
    failed: failed.length,
    retried,
    jobsPerSec: Number(jobsPerSec.toFixed(1)),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    drainSec: Number((windowMs / 1000).toFixed(2)),
  };

  console.log('--- queue measurement ---');
  for (const [k, v] of Object.entries(report)) {
    if (v !== '') console.log(`  ${k.padEnd(12)} ${v}`);
  }
  console.log('  failures by reason:');
  const entries = Object.entries(failureBreakdown).sort((a, b) => b[1] - a[1]);
  if (!entries.length) console.log('    (none)');
  else entries.forEach(([k, v]) => console.log(`    ${String(v).padStart(5)}  ${k}`));

  const csvPath = arg('csv');
  if (csvPath) {
    const header =
      'label,strategy,concurrency,poolMax,total,completed,failed,retried,jobsPerSec,p50Ms,p95Ms,drainSec,outOfStock,duplicate,lockTimeout,other\n';
    if (!existsSync(csvPath)) writeFileSync(csvPath, header);

    const known = ['OUT_OF_STOCK', 'DUPLICATE_ORDER', 'LOCK_TIMEOUT'];
    const other = entries.filter(([k]) => !known.includes(k)).reduce((s, [, v]) => s + v, 0);

    appendFileSync(
      csvPath,
      [
        report.label,
        report.strategy,
        report.concurrency,
        report.poolMax,
        report.total,
        report.completed,
        report.failed,
        report.retried,
        report.jobsPerSec,
        report.p50Ms,
        report.p95Ms,
        report.drainSec,
        failureBreakdown['OUT_OF_STOCK'] || 0,
        failureBreakdown['DUPLICATE_ORDER'] || 0,
        failureBreakdown['LOCK_TIMEOUT'] || 0,
        other,
      ].join(',') + '\n',
    );
    console.log(`\nappended to ${csvPath}`);
  }

  await queue.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
