FROM node:lts-alpine AS deps
ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --omit=dev && npm cache clean --force

FROM node:lts-alpine
ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY . .

RUN chown -R node:node /usr/src/app

EXPOSE 32004
USER node
CMD ["node", "index.js"]
