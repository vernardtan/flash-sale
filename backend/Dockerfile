# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM node:24-alpine AS build
# Prisma engines link against OpenSSL.
RUN apk add --no-cache openssl
WORKDIR /app

# prisma/ must be present before install: the postinstall hook runs
# `prisma generate`.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:24-alpine AS production
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --chmod=755 entrypoint.sh ./

# The prisma CLI ships as a regular dependency so the container can apply
# migrations (`migrate deploy`) before accepting traffic. The development
# seed runs only when SEED_ON_STARTUP=true; a seed failure never blocks
# startup (it is idempotent and re-runnable).
USER node
EXPOSE 3000
ENTRYPOINT ["./entrypoint.sh"]
