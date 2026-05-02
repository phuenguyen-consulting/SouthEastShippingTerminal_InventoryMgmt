# ── Stage 1: Build React frontend ───────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# ── Stage 2: Production image ────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server/ ./server/
COPY --from=builder /app/dist ./dist

# Cloud Run injects PORT=8080
EXPOSE 8080
CMD ["node", "server/index.js"]
