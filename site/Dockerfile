# Presentation site: the Lovable project in v4/, built and run as a small Node server.
FROM node:24-alpine AS build
WORKDIR /app
COPY v4/package.json v4/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY v4/ ./
RUN NITRO_PRESET=node-server npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/.output ./.output
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node", ".output/server/index.mjs"]
