# ---- build stage ----
FROM golang:1.22-alpine AS build
WORKDIR /src

# Cache modules first
COPY go.mod ./
RUN go mod download 2>/dev/null || true
COPY . .
# Bake the build time into the binary as a version marker (see main.go /
# GET /api/version) so you can always tell, after a deploy, whether the
# server is actually running the image you just built.
# Version = <release number>-<UTC build time>. The release number comes from
# the VERSION file (edit that file to bump it), or from
# `--build-arg APP_VERSION=x.y.z` if given. The timestamp part still changes
# on every build, so a stale deploy is easy to spot.
ARG APP_VERSION=""
RUN VER="${APP_VERSION:-$(cat VERSION 2>/dev/null | tr -d '[:space:]')}" && \
    BUILD_VERSION="${VER:-0.0.0}-$(date -u +%Y%m%d-%H%M%S)" && \
    go mod tidy && \
    CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w -X main.buildVersion=${BUILD_VERSION}" -o /out/webssh .

# ---- runtime stage ----
FROM alpine:3.20
# su-exec lets the entrypoint start as root (so it can fix ownership of a
# freshly-mounted volume), then drop to the unprivileged webssh user.
RUN apk add --no-cache ca-certificates tzdata su-exec && \
    addgroup -S webssh && adduser -S webssh -G webssh

WORKDIR /app
COPY --from=build /out/webssh /app/webssh
COPY web/ /app/web/
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh && mkdir -p /data

ENV DATA_DIR=/data \
    WEB_DIR=/app/web \
    LISTEN_ADDR=:8080
# Change these in production (or pass via `docker run -e ...`)
ENV ADMIN_USER=admin \
    ADMIN_PASSWORD=admin

EXPOSE 8080
VOLUME ["/data"]

# Container starts as root; entrypoint chowns $DATA_DIR then execs the app
# as the unprivileged "webssh" user.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
