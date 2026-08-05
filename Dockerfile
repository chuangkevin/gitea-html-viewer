FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
ARG BUILD_SHA
ENV VITE_BUILD_SHA=$BUILD_SHA
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev -w server
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/client/dist client/dist
WORKDIR /app/server
EXPOSE 3210
CMD ["node", "dist/index.js"]
