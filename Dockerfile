# The Vexa API, with the Zcash light wallet its stealth router drives.
#
#   docker build -t vexa-api .
#   docker run --env-file .env -p 8787:8787 -v vexa-zcash:/data vexa-api
#
# Railway builds this file (railway.json). Mount a volume at /data: the Zcash
# wallet's sync state lives in /data/zcash.

# --- zingo-cli and nym-proxy (zingolib, pinned) ------------------------------
FROM rust:1-bookworm AS zingo
RUN apt-get update \
 && apt-get install -y --no-install-recommends protobuf-compiler \
 && rm -rf /var/lib/apt/lists/*
ARG ZINGOLIB_TAG=zingolib_v6.0.0
RUN git clone --depth 1 --branch "${ZINGOLIB_TAG}" https://github.com/zingolabs/zingolib /src/zingolib
WORKDIR /src/zingolib
# zingo-cli goes online through the Nym mixnet by default; nym-proxy is the
# transport it spawns, built from its own workspace.
RUN cargo build --release -p zingo-cli \
 && cargo build --release --manifest-path zingo-netutils/Cargo.toml --features nym --bin nym-proxy

# --- the API ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter=@vexa/api... \
 && pnpm --filter @vexa/api deploy --prod /app

# --- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=zingo /src/zingolib/target/release/zingo-cli /usr/local/bin/zingo-cli
COPY --from=zingo /src/zingolib/zingo-netutils/target/release/nym-proxy /usr/local/bin/nym-proxy
WORKDIR /app
COPY --from=build /app .
ENV NODE_ENV=production \
    ZINGO_CLI_PATH=/usr/local/bin/zingo-cli \
    ZINGO_NYM_PROXY=/usr/local/bin/nym-proxy \
    ZCASH_DATA_DIR=/data/zcash
# Runs as root: Railway mounts volumes owned by root, and the wallet writes to /data.
CMD ["node", "dist/index.js"]
