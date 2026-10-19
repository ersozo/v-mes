# Derleme bağlamı: depo kökü
FROM node:24-alpine AS build
WORKDIR /w
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @vmes/web...
COPY apps/web apps/web
RUN pnpm --filter @vmes/web build

FROM nginx:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/web/security-headers.conf /etc/nginx/snippets/security-headers.conf
# Üretim (TLS) yapılandırması imajda hazır bekler; docker-compose.prod.yml etkinleştirir
COPY apps/web/nginx.tls.conf /etc/nginx/mes/nginx.tls.conf
COPY apps/web/security-headers.tls.conf /etc/nginx/mes/security-headers.tls.conf
COPY --from=build /w/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
