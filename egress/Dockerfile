# Egress proxy for OpenDuet's computer: Stripe smokescreen (MIT), built from the v0.1.0 tag pinned to
# its commit. Why smokescreen: it is an SSRF-focused HTTP/CONNECT proxy that resolves a destination
# once, classifies the resolved address and dials exactly that address (no DNS-rebinding window),
# and by default refuses everything that is not public unicast: loopback, RFC 1918, link-local
# (169.254.0.0/16 including the 169.254.169.254 metadata address, fe80::/10), CGNAT 100.64.0.0/10,
# IPv6 ULA fc00::/7 and IPv4-embedding IPv6 forms. The --deny-range list below restates those
# ranges explicitly and adds the remaining special-purpose blocks. 198.18.0.0/15 is allowed only
# when ALLOW_FAKE_IP_RANGE=1 or auto detects fake-IP answers for fixed public DNS probes.
# Denied requests get HTTP 407
# with an X-Smokescreen-Error header. ::ffff:0:0/96 is not listed: Go stores IPv4 in that mapped
# form, so the range would match every IPv4 address; smokescreen refuses IPv4-mapped, NAT64, 6to4
# and Teredo forms on its own.
#
# Built with the build platform's Go and cross-compiled (CGO off), so linux/amd64 and linux/arm64
# images build without emulation.
ARG GO_IMAGE=golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59
ARG RUNTIME_IMAGE=alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build
ARG SMOKESCREEN_COMMIT=609eb8931420453daf5893509be0b25b21bd9edb
# Override for networks that cannot reach proxy.golang.org (e.g. https://goproxy.cn,direct).
ARG GOPROXY=https://proxy.golang.org,direct
ARG TARGETOS
ARG TARGETARCH
RUN apk add --no-cache git
WORKDIR /src
RUN git init -q . \
  && git remote add origin https://github.com/stripe/smokescreen.git \
  && git fetch -q --depth 1 origin "${SMOKESCREEN_COMMIT}" \
  && git checkout -q FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = "${SMOKESCREEN_COMMIT}"
RUN GOPROXY="${GOPROXY}" go mod download
# The pinned upstream ACL has domain rules, not port rules. Patch the shared HTTP/CONNECT hook.
COPY port-policy.go port-policy_test.go pkg/smokescreen/
COPY restrict-ports.awk /tmp/restrict-ports.awk
RUN awk -f /tmp/restrict-ports.awk pkg/smokescreen/smokescreen.go > /tmp/smokescreen.go \
  && mv /tmp/smokescreen.go pkg/smokescreen/smokescreen.go \
  && go test ./pkg/smokescreen -run '^TestOpenDuetPorts$' -count=1
RUN CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
    go build -trimpath -ldflags="-s -w" -o /out/smokescreen . \
  && cp LICENSE.txt /out/LICENSE.smokescreen.txt

FROM ${RUNTIME_IMAGE}
# Fixed non-root UID; busybox wget is used by the compose healthcheck.
RUN addgroup -S -g 10002 egress && adduser -S -D -H -u 10002 -G egress egress
COPY --from=build /out/smokescreen /usr/local/bin/smokescreen
COPY --from=build /out/LICENSE.smokescreen.txt /usr/share/licenses/smokescreen/LICENSE.txt
COPY fake-ip.sh /usr/local/lib/openduet-fake-ip.sh
COPY entrypoint.sh /usr/local/bin/openduet-egress-entrypoint.sh
USER 10002:10002
EXPOSE 3128
ENTRYPOINT ["/bin/sh", "/usr/local/bin/openduet-egress-entrypoint.sh"]
CMD ["--listen-port=3128", \
     "--deny-range=0.0.0.0/8", \
     "--deny-range=10.0.0.0/8", \
     "--deny-range=100.64.0.0/10", \
     "--deny-range=127.0.0.0/8", \
     "--deny-range=169.254.0.0/16", \
     "--deny-range=172.16.0.0/12", \
     "--deny-range=192.0.0.0/24", \
     "--deny-range=192.0.2.0/24", \
     "--deny-range=192.88.99.0/24", \
     "--deny-range=192.168.0.0/16", \
     "--deny-range=198.51.100.0/24", \
     "--deny-range=203.0.113.0/24", \
     "--deny-range=224.0.0.0/4", \
     "--deny-range=240.0.0.0/4", \
     "--deny-range=::/128", \
     "--deny-range=::1/128", \
     "--deny-range=64:ff9b::/96", \
     "--deny-range=64:ff9b:1::/48", \
     "--deny-range=100::/64", \
     "--deny-range=2001:db8::/32", \
     "--deny-range=2001::/32", \
     "--deny-range=2002::/16", \
     "--deny-range=fc00::/7", \
     "--deny-range=fe80::/10", \
     "--deny-range=ff00::/8"]
