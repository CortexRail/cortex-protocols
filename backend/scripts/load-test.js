#!/usr/bin/env node

const { spawn } = require('child_process');

const REQUIRED = {
  assets: { concurrency: 500, duration: 30, path: '/api/v1/assets', name: 'assets' },
  agents: { concurrency: 200, duration: 30, path: '/api/v1/agents', name: 'agents' },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { target: null, url: process.env.API_URL || 'http://localhost:4000' };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--target') opts.target = args[i + 1];
    else if (arg === '--url') opts.url = args[i + 1];
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }

  return opts;
}

function runAutocannon(target, { concurrency, duration, path, name }) {
  return new Promise((resolve, reject) => {
    const args = [
      `${target}${path}`,
      '--connections', String(concurrency),
      '--duration', String(duration),
      '--warmup', '2',
      '--json',
    ];

    const proc = spawn('npx', ['autocannon', ...args], { stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`autocannon failed for ${name}: ${stderr || stdout || 'exit code ' + code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({ name, target, ...parsed });
      } catch (err) {
        reject(new Error(`invalid autocannon JSON for ${name}: ${err.message}\n${stdout}\n${stderr}`));
      }
    });
  });
}

function summarize(result) {
  const latency = result.latency || result.aggregates?.latency || {};
  const p99 = Number(latency.p99 ?? latency['p99'] ?? 0);
  const errors = Number(result.non2xx || 0);
  const totalRequests = Number(
    result.requests?.total ??
      Object.values(result.statusCodes || {}).reduce((sum, count) => sum + Number(count || 0), 0) ??
      0,
  );
  const errorRate = totalRequests > 0 ? (errors / totalRequests) * 100 : 0;

  return {
    name: result.name,
    target: result.target,
    concurrency: Number(result.connections?.average ?? result.connections ?? 0),
    durationSeconds: Number(result.duration || 0),
    totalRequests,
    errors,
    errorRate,
    p99Ms: p99,
    p99WithinTarget: p99 < 200,
    errorWithinTarget: errorRate < 0.1,
  };
}

async function main() {
  const opts = parseArgs();
  if (opts.help || !opts.target) {
    console.log('Usage: node scripts/load-test.js --target <name:assets|agents> --url http://localhost:4000');
    console.log('Examples:');
    console.log('  node scripts/load-test.js --target assets');
    console.log('  node scripts/load-test.js --target agents --url http://localhost:4000');
    return;
  }

  const targetKey = opts.target.toLowerCase();
  const scenario = REQUIRED[targetKey];

  if (!scenario) {
    throw new Error(`Unknown target "${opts.target}". Choose: ${Object.keys(REQUIRED).join(', ')}`);
  }

  console.log(`Running ${scenario.name} load test at ${opts.url}${scenario.path} (${scenario.concurrency} connections, ${scenario.duration}s)`);
  const raw = await runAutocannon(opts.url, scenario);
  const summary = summarize(raw);

  console.log(JSON.stringify({
    name: summary.name,
    target: summary.target,
    concurrency: summary.concurrency,
    durationSeconds: summary.durationSeconds,
    totalRequests: summary.totalRequests,
    errors: summary.errors,
    errorRatePct: Number(summary.errorRate.toFixed(4)),
    p99LatencyMs: Number(summary.p99Ms.toFixed(2)),
    thresholds: {
      p99LatencyMs: '<200',
      errorRatePct: '<0.1',
    },
    pass: summary.p99WithinTarget && summary.errorWithinTarget,
  }, null, 2));

  if (!summary.p99WithinTarget || !summary.errorWithinTarget) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
