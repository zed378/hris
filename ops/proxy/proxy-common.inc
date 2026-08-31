# Headers every upstream needs, in one place.
#
# X-Forwarded-For is what the rate limiter counts by and what an attendance punch
# is matched against for office-network verification. Getting it wrong does not
# raise: it silently makes every request look like it came from the proxy, so one
# limit is shared by everybody and every punch appears to arrive from the same
# address.
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Connection "";

# Passed through rather than regenerated, so one request is one story across the
# services it touches (PLAN/14 §9.3).
proxy_set_header X-Correlation-Id $http_x_correlation_id;

# NEVER forwarded from a client. The auth service trusts this header to identify
# an internal caller; accepting one from outside would let anyone present it.
proxy_set_header X-Internal-Secret "";
