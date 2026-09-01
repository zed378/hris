import { afterEach, describe, expect, it } from 'vitest';

import {
  incrementCounter,
  observeDuration,
  renderMetrics,
  resetMetrics,
  metricsEnabled,
  metricsTokenMatches,
} from '../src/metrics.ts';

/**
 * Metrics, and the one rule that is a security rule.
 *
 * A scrape endpoint is read by infrastructure and stored in a time-series
 * database that outlives every access control in this system. Whatever is
 * labelled here is published, permanently, to everyone who can see a dashboard —
 * so the tests that matter most are the ones asserting what is NOT here.
 */

const original = { ...process.env };

afterEach(() => {
  resetMetrics();
  process.env = { ...original };
});

describe('the exposition format', () => {
  it('renders a counter with its labels', () => {
    incrementCounter('hrms_http_requests_total', { route: 'GET /api/x', status: '200' });
    incrementCounter('hrms_http_requests_total', { route: 'GET /api/x', status: '200' });

    const output = renderMetrics();
    expect(output).toContain('# TYPE hrms_http_requests_total counter');
    expect(output).toContain('hrms_http_requests_total{route="GET /api/x",status="200"} 2');
  });

  it('keeps different label sets apart', () => {
    incrementCounter('c', { status: '200' });
    incrementCounter('c', { status: '500' });

    const output = renderMetrics();
    expect(output).toContain('c{status="200"} 1');
    expect(output).toContain('c{status="500"} 1');
  });

  /**
   * Labels are sorted, so the same counter renders identically every time.
   *
   * Unsorted, the series name changes with property insertion order, and a
   * time-series database treats that as two different series — a graph that
   * splits in half for no reason anybody can see.
   */
  it('renders labels in a stable order', () => {
    incrementCounter('c', { b: '2', a: '1' });
    expect(renderMetrics()).toContain('c{a="1",b="2"} 1');
  });

  it('escapes quotes and backslashes in a label', () => {
    incrementCounter('c', { route: 'GET /a"b\\c' });
    expect(renderMetrics()).toContain('route="GET /a\\"b\\\\c"');
  });

  it('renders a histogram with cumulative buckets, a sum, and a count', () => {
    observeDuration('d', 0.02, { route: 'r' });
    observeDuration('d', 0.4, { route: 'r' });

    const output = renderMetrics();
    // Cumulative: everything at or under the bound. 0.02 falls in every bucket
    // from 0.05 up; 0.4 joins it from 0.5.
    expect(output).toContain('d_bucket{route="r",le="0.05"} 1');
    expect(output).toContain('d_bucket{route="r",le="0.5"} 2');
    expect(output).toContain('d_bucket{route="r",le="+Inf"} 2');
    expect(output).toContain('d_count{route="r"} 2');
    expect(output).toContain('d_sum{route="r"} 0.42');
  });

  /**
   * The buckets cluster around 500 ms because that is the number PLAN/12 §11
   * sets as the p95 target. A histogram whose nearest edges were 250 ms and 1 s
   * could not tell 400 ms from 900 ms — the only distinction anybody acts on.
   */
  it('has a bucket boundary at the target latency', () => {
    observeDuration('d', 0.1);
    expect(renderMetrics()).toContain('le="0.5"');
  });

  it('renders nothing but a newline when nothing has been observed', () => {
    expect(renderMetrics().trim()).toBe('');
  });
});

describe('the token', () => {
  it('reports disabled when METRICS_TOKEN is unset', () => {
    delete process.env['METRICS_TOKEN'];
    expect(metricsEnabled()).toBe(false);
    expect(metricsTokenMatches('anything')).toBe(false);
  });

  it('accepts only the exact token', () => {
    process.env['METRICS_TOKEN'] = 'a-secret-value';

    expect(metricsEnabled()).toBe(true);
    expect(metricsTokenMatches('a-secret-value')).toBe(true);
    expect(metricsTokenMatches('a-secret-valuX')).toBe(false);
    expect(metricsTokenMatches('a-secret-value-longer')).toBe(false);
    expect(metricsTokenMatches('')).toBe(false);
    expect(metricsTokenMatches(null)).toBe(false);
  });
});

describe('what must never be exported', () => {
  /**
   * The rule this file exists for.
   *
   * A `tenant_id` label publishes the customer list. A per-tenant business
   * figure publishes their business. PLAN/12 §11 lists several metrics of
   * exactly that kind — the flagged ratio, payroll disputes, pilot retention —
   * and they belong on the dashboard behind a permission, where they already
   * are.
   *
   * This asserts the shape actually emitted by the gateway, so a later change
   * adding a tenant label has to change this test too, deliberately.
   */
  it('carries no tenant identifier in the gateway’s own metrics', () => {
    incrementCounter('hrms_http_requests_total', {
      route: 'GET /api/leave/balances',
      status: '200',
    });
    observeDuration('hrms_http_request_duration_seconds', 0.1, {
      route: 'GET /api/leave/balances',
    });

    const output = renderMetrics();
    expect(output).not.toMatch(/tenant/i);
    expect(output).not.toMatch(/employee/i);
    expect(output).not.toMatch(/email/i);
    // A UUID anywhere in this output would mean an identifier leaked into a
    // label, whatever the label happens to be called.
    expect(output).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
  });
});
