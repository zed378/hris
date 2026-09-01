/**
 * Metrics, in the Prometheus text format (PLAN/14 §9.3).
 *
 * `PLAN/13` recorded "there are no metrics yet — added when someone actually
 * collects them", and that restraint was right: an endpoint nobody scrapes is a
 * maintenance burden pretending to be observability. What changed is the split.
 * With four containers, "is it slow?" and "is it erroring?" stop being questions
 * a single log stream can answer by eye.
 *
 * So the endpoint exists and is **disabled unless `METRICS_TOKEN` is set**. A
 * deployment that collects nothing carries a few counters in memory and serves a
 * 404, which is what it had before.
 *
 * ## Technical metrics only. Never tenant data.
 *
 * This is the rule that matters, and it is a security rule rather than a design
 * preference. A scrape endpoint is read by infrastructure, stored in a
 * time-series database, and displayed on dashboards that outlive every access
 * control this system has. Labelling a counter by `tenant_id` publishes the
 * customer list; exporting a flagged ratio per tenant publishes their business.
 *
 * `PLAN/12` §11 lists ten metrics worth watching and several of them are exactly
 * that kind — the flagged ratio, payroll disputes, pilot retention. **Those
 * belong on the dashboard, behind a permission**, and they are already there.
 * What lives here is what an operator needs and no customer would recognise:
 * request counts, durations, and error rates, with no tenant identifier anywhere.
 *
 * ## Per-process counters are CORRECT here
 *
 * Unlike the rate limiter — where per-process counting silently multiplied the
 * limit by the replica count — Prometheus scrapes each instance separately and
 * sums across them itself. Sharing these in Redis would be wrong, not merely
 * unnecessary: two replicas would each report the other's traffic as their own.
 */

interface Histogram {
  /** Upper bounds in seconds, ascending. */
  buckets: number[];
  counts: number[];
  sum: number;
  total: number;
}

const counters = new Map<string, number>();
const histograms = new Map<string, Histogram>();

/**
 * Buckets chosen around the number that matters.
 *
 * `PLAN/12` §11 sets the p95 target at 500 ms, so the boundaries cluster there:
 * a histogram whose nearest edges are 250 ms and 1 s cannot tell 400 ms from
 * 900 ms, and that is the only distinction anybody would act on.
 */
const DEFAULT_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function key(name: string, labels: Record<string, string>): string {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length > 0 ? `${name}{${parts.join(',')}}` : name;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function incrementCounter(
  name: string,
  labels: Record<string, string> = {},
  by = 1,
): void {
  const id = key(name, labels);
  counters.set(id, (counters.get(id) ?? 0) + by);
}

export function observeDuration(
  name: string,
  seconds: number,
  labels: Record<string, string> = {},
): void {
  const id = key(name, labels);
  let histogram = histograms.get(id);

  if (!histogram) {
    histogram = {
      buckets: DEFAULT_BUCKETS,
      counts: new Array(DEFAULT_BUCKETS.length).fill(0),
      sum: 0,
      total: 0,
    };
    histograms.set(id, histogram);
  }

  histogram.sum += seconds;
  histogram.total += 1;
  for (let i = 0; i < histogram.buckets.length; i += 1) {
    if (seconds <= histogram.buckets[i]!) histogram.counts[i]! += 1;
  }
}

/** True when this process is configured to expose metrics at all. */
export function metricsEnabled(): boolean {
  return Boolean(process.env['METRICS_TOKEN']?.trim());
}

/**
 * Whether a presented token may read the metrics.
 *
 * Compared at constant time. A metrics token is a low-value secret and this is a
 * cheap habit; the expensive habit is deciding case by case which secrets
 * deserve it.
 */
export function metricsTokenMatches(presented: string | null | undefined): boolean {
  const expected = process.env['METRICS_TOKEN'];
  if (!expected || !presented) return false;
  if (expected.length !== presented.length) return false;

  let differences = 0;
  for (let i = 0; i < expected.length; i += 1) {
    differences |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  }
  return differences === 0;
}

/** Renders everything collected so far, in the Prometheus text exposition format. */
export function renderMetrics(): string {
  const lines: string[] = [];
  const described = new Set<string>();

  const describe = (id: string, type: string, help: string): void => {
    const name = id.split('{')[0]!;
    if (described.has(name)) return;
    described.add(name);
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
  };

  for (const [id, value] of [...counters].sort()) {
    describe(id, 'counter', 'Cumulative count since this process started.');
    lines.push(`${id} ${value}`);
  }

  for (const [id, histogram] of [...histograms].sort()) {
    const name = id.split('{')[0]!;
    const labels = id.slice(name.length).replace(/^\{|\}$/g, '');
    const withLabel = (extra: string): string =>
      labels ? `${name}_bucket{${labels},${extra}}` : `${name}_bucket{${extra}}`;

    describe(id, 'histogram', 'Observed durations in seconds.');

    for (let i = 0; i < histogram.buckets.length; i += 1) {
      lines.push(`${withLabel(`le="${histogram.buckets[i]}"`)} ${histogram.counts[i]}`);
    }
    lines.push(`${withLabel('le="+Inf"')} ${histogram.total}`);
    lines.push(`${labels ? `${name}_sum{${labels}}` : `${name}_sum`} ${histogram.sum}`);
    lines.push(`${labels ? `${name}_count{${labels}}` : `${name}_count`} ${histogram.total}`);
  }

  return `${lines.join('\n')}\n`;
}

/** For tests. */
export function resetMetrics(): void {
  counters.clear();
  histograms.clear();
}
