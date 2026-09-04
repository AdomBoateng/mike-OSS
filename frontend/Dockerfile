# syntax=docker/dockerfile:1

# ---- build stage ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
# NEXT_PUBLIC_API_BASE_URL is intentionally NOT baked here: the app derives the
# backend URL from the request host at runtime (see mikeApi resolveApiBase), so
# one image works for any server IP.
RUN npm run build

# ---- runtime stage (Next.js standalone) ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --chown=node:node --from=build /app/public ./public
COPY --chown=node:node --from=build /app/.next/standalone ./
COPY --chown=node:node --from=build /app/.next/static ./.next/static
EXPOSE 3000
USER node
CMD ["node", "server.js"]
