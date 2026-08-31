# SSE behind a real proxy

The attendance dashboard streams punches over Server-Sent Events. Every claim
about how that behaves behind nginx was, until this directory existed, reasoning
rather than measurement — `PLAN/13` carried "the SSE stream has not been tested
behind a real proxy" as an open item.

This reproduces the test. It is not part of `pnpm verify`: it needs Docker, a
running application, and a valid token, so it is a thing you run deliberately.

## Running it

```bash
# 1. The application, built and running on :3000
pnpm --filter @hrms/web build && pnpm --filter @hrms/web start

# 2. Three proxies in front of it
docker run -d --name hrms-nginx-test \
  -p 8081:8080 -p 8091:8090 -p 8101:8100 \
  --add-host=host.docker.internal:host-gateway \
  -v "$PWD/ops/proxy-test/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:alpine

# 3. A token, and the probe
python ops/proxy-test/sse-probe.py http://localhost:8081 "$LISTEN_TOKEN" "$PUNCH_TOKEN"
```

The probe opens the stream, waits, submits a punch with a second account, and
reports how long the event took to arrive. It requests `Accept-Encoding: gzip`
and decompresses incrementally, because that is what a browser does and because
compression is the thing most likely to hold events back.

## The three ports, and why

| Port | Configuration | Question it answers |
|---|---|---|
| 8081 | nginx defaults | Does it work at all for an operator who never thought about SSE? |
| 8091 | `proxy_ignore_headers X-Accel-Buffering` | Is our header what makes it work, or is it working by accident? |
| 8101 | `gzip_proxied any`, event streams included | Does compression hold events in the compressor's buffer? |

Port 8091 is the mutation test. Without it, a passing result on 8081 proves only
that *something* works, and a decorative header would look identical to a
load-bearing one.

## What it measured (31 August 2026)

| Configuration | `ready` | Punch propagation |
|---|---|---|
| Direct, no proxy | 0.20 s | — |
| nginx defaults | 0.08 s | **0.08 s** |
| nginx ignoring `X-Accel-Buffering` | 0.08 s | **0.08 s** |
| nginx gzipping the stream | 0.09 s | **0.07 s** |

Two findings, and the second one is a correction:

1. **SSE works behind nginx**, including with compression applied to the stream.
2. **`x-accel-buffering: no` was not load-bearing in any configuration tested.**
   The comment on the header claimed that without it "events pile up in the proxy
   and the live dashboard falls seconds behind until the buffer fills". Port 8091
   is exactly that scenario and the delay was 0.08 s. nginx forwards each
   upstream chunk as it arrives rather than holding it back; buffering protects
   against slow *clients*, which is a different problem.

The header stays. It is correct, it costs nothing, and other proxies — and other
nginx versions and configurations — do act on it. What changed is the claim made
about it, which was stronger than the evidence.

A third thing worth knowing: **nginx compressed the event stream despite
`cache-control: no-transform`**, which nginx is documented to honour. Harmless
here, but it means an SSE stream in production may well be gzipped, and anything
that assumes otherwise is assuming.

## Not covered

- Only nginx. Not tested behind Cloudflare, an AWS ALB, or an Azure Front Door,
  and those buffer on their own terms.
- One client at a time. Concurrent-stream behaviour under a proxy is untested.
- No TLS. HTTP/2 multiplexing changes how streams are framed.
