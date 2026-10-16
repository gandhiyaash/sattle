/**
 * Prometheus metrics, without a client library: request counts and latency by
 * route pattern, the Node process, and settlements by status.
 *
 * Served on their own listener (METRICS_ADDR, e.g. 127.0.0.1:9464) and never
 * on the API port, which nginx exposes to the internet. Unset, nothing listens
 * and the middleware only counts in memory.
 */

import { createServer, type Server } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';

import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';

import type { Db } from './db';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Series {
  labels: string;
  count: number;
  sum: number;
  buckets: number[];
}

const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export class Metrics {
  private readonly series = new Map<string, Series>();
  private readonly started = Date.now();
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 20 });

  constructor(private readonly db?: Db) {
    this.loopDelay.enable();
  }

  /** `route` is the registered pattern (/s/:token), so tokens in paths never become labels. */
  observe(method: string, route: string, status: number, seconds: number) {
    const labels = `method="${escape(method)}",route="${escape(route)}",status="${status}"`;
    let s = this.series.get(labels);
    if (!s) {
      s = { labels, count: 0, sum: 0, buckets: BUCKETS.map(() => 0) };
      this.series.set(labels, s);
    }
    s.count++;
    s.sum += seconds;
    BUCKETS.forEach((le, i) => {
      if (seconds <= le) s.buckets[i]++;
    });
  }

  render(): string {
    const out: string[] = [];
    out.push('# HELP sattle_http_requests_total Requests answered, by route pattern and status.');
    out.push('# TYPE sattle_http_requests_total counter');
    for (const s of this.series.values()) out.push(`sattle_http_requests_total{${s.labels}} ${s.count}`);

    out.push('# HELP sattle_http_request_duration_seconds Time to answer. Event streams count until their response starts.');
    out.push('# TYPE sattle_http_request_duration_seconds histogram');
    for (const s of this.series.values()) {
      BUCKETS.forEach((le, i) =>
        out.push(`sattle_http_request_duration_seconds_bucket{${s.labels},le="${le}"} ${s.buckets[i]}`)
      );
      out.push(`sattle_http_request_duration_seconds_bucket{${s.labels},le="+Inf"} ${s.count}`);
      out.push(`sattle_http_request_duration_seconds_sum{${s.labels}} ${s.sum}`);
      out.push(`sattle_http_request_duration_seconds_count{${s.labels}} ${s.count}`);
    }

    if (this.db) {
      out.push('# HELP sattle_settlements Settlements in the database, by status.');
      out.push('# TYPE sattle_settlements gauge');
      const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM settlements GROUP BY status').all() as {
        status: string;
        n: number;
      }[];
      for (const r of rows) out.push(`sattle_settlements{status="${escape(r.status)}"} ${r.n}`);
    }

    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    out.push('# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${mem.rss}`);
    out.push('# TYPE nodejs_heap_used_bytes gauge', `nodejs_heap_used_bytes ${mem.heapUsed}`);
    out.push('# TYPE nodejs_heap_total_bytes gauge', `nodejs_heap_total_bytes ${mem.heapTotal}`);
    out.push('# TYPE process_cpu_seconds_total counter', `process_cpu_seconds_total ${(cpu.user + cpu.system) / 1e6}`);
    out.push('# TYPE process_start_time_seconds gauge', `process_start_time_seconds ${Math.floor(this.started / 1000)}`);
    out.push(
      '# HELP nodejs_eventloop_lag_p99_seconds Event loop delay, 99th percentile since the last scrape.',
      '# TYPE nodejs_eventloop_lag_p99_seconds gauge',
      `nodejs_eventloop_lag_p99_seconds ${this.loopDelay.percentile(99) / 1e9}`
    );
    this.loopDelay.reset();
    return out.join('\n') + '\n';
  }
}

export function metricsMiddleware(metrics: Metrics): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    await next();
    // The last matched route is the handler's; a lone '*' means only middleware matched.
    const route = routePath(c, -1);
    metrics.observe(c.req.method, !route || route === '/*' || route === '*' ? 'unmatched' : route, c.res.status,
      (performance.now() - start) / 1000);
  };
}

/** Listens on host:port. Meant for loopback; Prometheus scrapes it from the same machine. */
export function serveMetrics(addr: string, metrics: Metrics): Server {
  const i = addr.lastIndexOf(':');
  const host = addr.slice(0, i) || '127.0.0.1';
  const port = Number(addr.slice(i + 1));
  const server = createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(metrics.render());
  });
  server.listen(port, host);
  return server;
}
