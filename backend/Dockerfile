# syntax=docker/dockerfile:1

# ---- build stage: compile TypeScript -> dist ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:22-bookworm-slim AS runtime

# LibreOffice (headless) for DOCX/DOC -> PDF conversion, plus base fonts.
# convert.ts auto-discovers /usr/bin/soffice, so no SOFFICE_BINARY_PATH needed.
# poppler-utils provides pdftoppm, which ocr.ts uses to rasterise scanned PDFs
# before sending the page images to the vision model.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     libreoffice-writer libreoffice-core fonts-liberation poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# The SQL a fresh or upgrading database needs. Kubernetes has no equivalent of
# the Postgres entrypoint hook docker-compose uses to seed a new volume, so the
# migration Job runs `node dist/scripts/migrate.js` from this same image and
# reads these paths. See docs/KUBERNETES.md.
COPY schema.sql ./schema.sql
COPY db ./db
COPY migrations ./migrations

EXPOSE 3001
CMD ["node", "dist/index.js"]
