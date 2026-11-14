# Build the NestJS API independently of the dashboard workspace.
FROM node:20-slim AS build
WORKDIR /app

COPY apps/api/package.json ./package.json
RUN npm install

COPY apps/api/tsconfig.json ./tsconfig.json
COPY apps/api/src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 8080
CMD ["node", "dist/main.js"]
