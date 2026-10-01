# Relayn server — multi-stage Docker build.
# Build:  docker build -t relayn-server .
# Run:    docker run -e PORT=4000 -e TRUST_PROXY=true -p 4000:4000 relayn-server

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["node", "dist/index.js"]
