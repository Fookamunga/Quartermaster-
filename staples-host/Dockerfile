FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# State lives in a mounted volume, never baked into the image.
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8481

CMD ["node", "dist/index.js"]
