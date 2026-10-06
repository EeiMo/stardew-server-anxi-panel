# Base images are overridable so a host that cannot reach registry-1.docker.io can
# still build locally through a registry mirror instead of depending on a
# prebuilt image. Example for a mainland China host that can reach docker.1ms.run
# but not Docker Hub, proxy.golang.org or the GHCR blob CDN:
#
#   docker build \
#     --build-arg NODE_IMAGE=docker.1ms.run/library/node:22-alpine \
#     --build-arg GOLANG_IMAGE=docker.1ms.run/library/golang:1.25-alpine \
#     --build-arg ALPINE_IMAGE=docker.1ms.run/library/alpine:3.20 \
#     --build-arg GOPROXY=https://goproxy.cn,direct \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
#     -t anxi-panel:local .
ARG NODE_IMAGE=node:22-alpine
ARG GOLANG_IMAGE=golang:1.25-alpine
ARG ALPINE_IMAGE=alpine:3.20

# ============================================================
# Stage 1: Build frontend (React/Vite)
# ============================================================
FROM ${NODE_IMAGE} AS frontend-builder

# Hosts that cannot reach registry.npmjs.org can pass
# --build-arg NPM_REGISTRY=https://registry.npmmirror.com.
ARG NPM_REGISTRY=https://registry.npmjs.org

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --include=dev --registry=${NPM_REGISTRY}
COPY frontend/ ./
COPY backend/internal/games/installerrors/catalog.json /app/backend/internal/games/installerrors/catalog.json
RUN npm run build

# ============================================================
# Stage 2: Build browser extension artifacts
# ============================================================
FROM ${ALPINE_IMAGE} AS extension-builder

WORKDIR /work

RUN apk add --no-cache zip
COPY browser-extensions/ browser-extensions/
RUN cd browser-extensions/nexus-slow-installer \
    && zip -qr ../anxi-nexus-installer.zip .

# ============================================================
# Stage 3: Build backend (Go)
# ============================================================
FROM ${GOLANG_IMAGE} AS backend-builder

ARG VERSION=dev
ARG COMMIT=
ARG BUILD_DATE=
# Networks that cannot reach proxy.golang.org (for example mainland China
# deployments) can pass --build-arg GOPROXY=https://goproxy.cn,direct.
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}

WORKDIR /src

# Cache dependency downloads.
COPY backend/go.mod backend/go.sum ./
RUN go mod download

# Copy frontend build output into the static embed directory.
COPY --from=frontend-builder /app/frontend/dist/ internal/static/frontend_dist/

# Copy Go source and build.
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w \
    -X 'github.com/eeimo/stardew-server-anxi-panel/backend/internal/config.buildVersion=${VERSION}' \
    -X 'github.com/eeimo/stardew-server-anxi-panel/backend/internal/config.buildCommit=${COMMIT}' \
    -X 'github.com/eeimo/stardew-server-anxi-panel/backend/internal/config.buildDate=${BUILD_DATE}'" \
    -o /app/panel ./cmd/panel
RUN CGO_ENABLED=0 GOOS=linux go build \
    -ldflags="-s -w" \
    -o /app/panel-updater ./cmd/panel-updater

# ============================================================
# Stage 4: Runtime image
# ============================================================
FROM ${ALPINE_IMAGE}

ARG VERSION=dev
ARG COMMIT=
ARG BUILD_DATE=

LABEL org.opencontainers.image.title="stardew-server-anxi-panel" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}"

RUN apk add --no-cache \
    bash \
    curl \
    docker-cli \
    docker-cli-compose \
    ca-certificates \
    tzdata

COPY --from=backend-builder /app/panel /app/panel
COPY --from=backend-builder /app/panel-updater /app/panel-updater
COPY deploy/migrate-fnos.sh /app/migrate-fnos.sh
COPY deploy/repair-junimo-upgrade.sh /app/repair-junimo-upgrade.sh
COPY --from=extension-builder /work/browser-extensions/ /app/browser-extensions/

RUN mkdir -p /data

EXPOSE 8090

VOLUME ["/data"]

HEALTHCHECK --interval=1m --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8090/health || exit 1

ENTRYPOINT ["/app/panel"]
