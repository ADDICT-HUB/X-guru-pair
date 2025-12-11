FROM node:18-slim

# Install system deps required by puppeteer (whatsapp-web.js)
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libgbm-dev \
    libxss1 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libasound2 \
    wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./ 
RUN npm ci --production

COPY . .

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "server/index.js"]
