FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production
COPY . .
RUN mkdir -p /app/data/uploads
EXPOSE 3000
CMD ["node", "src/server.js"]
