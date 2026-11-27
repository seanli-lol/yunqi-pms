# 带 Cloudflare DNS-01 插件的 Caddy 镜像（无需开放 80/443 端口即可自动申请/续期 HTTPS 证书）
FROM caddy:2-builder-alpine AS builder
ENV GOPROXY=https://goproxy.cn,direct
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
