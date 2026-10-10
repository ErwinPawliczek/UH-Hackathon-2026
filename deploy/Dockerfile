# Chain Reaction hosted demo image (§11): the C++ engine builds as a native
# binary, the web shell builds with Node, and the runtime ships both so
# crx-server serves the API and the front end from one origin.
#
# Internal listen port: 8080 (CRX_PORT). Fly.io maps its edge to it — see
# fly.toml and README.md.

# ---- stage 1: web front end ----
FROM node:22-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- stage 2: native server (same toolchain family as CI) ----
FROM debian:trixie AS native
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates cmake g++ ninja-build \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY CMakeLists.txt CMakePresets.json ./
COPY engine/ engine/
COPY apps/ apps/
# Server binary only: CI owns the tests; the image ships the demo.
RUN cmake --preset native-release \
 && cmake --build --preset native-release --target crx-server

# ---- stage 3: runtime ----
FROM debian:trixie-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends libstdc++6 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=native /src/build/native-release/crx-server /app/crx-server
COPY --from=web /src/web/dist /app/web/dist

ENV CRX_PORT=8080 \
    CRX_WEB_DIR=/app/web/dist
EXPOSE 8080

ENTRYPOINT ["/app/crx-server"]
