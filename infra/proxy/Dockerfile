# Imagen del proxy: compila la web y la sirve con Caddy.
# Se construye desde la raíz del repositorio (ver docker-compose.yml).

FROM node:22-alpine AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web ./
RUN npm run build

FROM caddy:2-alpine
COPY infra/proxy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /web/dist /srv
