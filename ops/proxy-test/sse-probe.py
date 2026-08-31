import sys, time, threading, json, zlib, urllib.request
base, listen_tok, punch_tok = sys.argv[1], sys.argv[2], sys.argv[3]

t0 = time.time(); events = []; enc = [None]

def listen():
    req = urllib.request.Request(base + '/api/attendance/live', headers={
        'Authorization': 'Bearer ' + listen_tok,
        'Accept': 'text/event-stream',
        # What every browser sends, always.
        'Accept-Encoding': 'gzip'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            enc[0] = r.headers.get('Content-Encoding')
            d = zlib.decompressobj(16 + zlib.MAX_WBITS) if enc[0] == 'gzip' else None
            buf = ''
            while time.time() - t0 < 14:
                chunk = r.read(1)
                if not chunk: break
                text = d.decompress(chunk).decode('utf-8', 'replace') if d else chunk.decode('utf-8', 'replace')
                if not text: continue
                buf += text
                while '\n' in buf:
                    line, buf = buf.split('\n', 1)
                    if line.startswith('event:'):
                        events.append((round(time.time() - t0, 2), line[6:].strip()))
                        if line.strip().endswith('punch'): return
    except Exception as e:
        events.append(('ERR', type(e).__name__))

th = threading.Thread(target=listen, daemon=True); th.start()
time.sleep(2.5)
body = json.dumps({'type': 'IN', 'punchedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                   'dedupeKey': 'sse-gz-' + str(int(time.time()))}).encode()
req = urllib.request.Request(base + '/api/attendance/punch', data=body, headers={
    'Authorization': 'Bearer ' + punch_tok, 'Content-Type': 'application/json'})
sent = round(time.time() - t0, 2)
try: urllib.request.urlopen(req, timeout=10).read()
except Exception as e: print('punch failed:', e)
th.join(timeout=12)
p = [e for e in events if e[1] == 'punch']
print(f'content-encoding={enc[0]} punch_sent_at={sent}s events={events} delay={round(p[0][0]-sent,2) if p else "NEVER ARRIVED"}')
