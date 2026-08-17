# ----------------------------------------------------------------- build
# better-sqlite3 и bcrypt — нативные модули. Готовые сборки публикуются под
# glibc, а alpine работает на musl, поэтому оба компилируются из исходников
# и на этой стадии нужен тулчейн. В финальный образ он не попадает — ради
# этого сборка и разделена.
FROM node:20-alpine AS build

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --------------------------------------------------------------- runtime
FROM node:20-alpine AS runtime

# tini как PID 1: корректно пробрасывает сигналы и подбирает осиротевшие
# процессы. Node в роли PID 1 сигналы получает, но зомби не пожинает.
RUN apk add --no-cache tini

ENV NODE_ENV=production

# Свой непривилегированный uid, а не встроенный node(1000): точки
# монтирования ниже создаются под него, и docker наследует владельца
# каталога из образа при инициализации пустого именованного тома.
RUN addgroup -g 10001 -S app \
  && adduser -u 10001 -S -G app -H -h /app app

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# /data — файл SQLite, /keys — приватный SSH-ключ. Оба монтируются томами.
RUN mkdir -p /data /keys \
  && chown -R app:app /data /keys /app \
  && chmod 700 /data /keys

USER app

EXPOSE 3000

# Наружу контейнер не публикуется, поэтому проба ходит на loopback.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
