FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS production
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/seed ./seed

# Default command runs the HTTP API (api1/api2/api3).
# The worker service overrides this with: node dist/worker.main
CMD ["node", "dist/main"]
