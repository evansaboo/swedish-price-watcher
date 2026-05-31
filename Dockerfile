FROM node:20-bookworm-slim

# Install Chromium system deps for Playwright (ARM64 compatible)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libatspi2.0-0 \
    libwayland-client0 \
    libx11-6 \
    libxcb1 \
    libxext6 \
    # Chromium itself (system package — avoids Playwright's x86 binary)
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Tell Playwright to use system Chromium instead of downloading its own
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY package*.json ./

# Skip postinstall (playwright-core install chromium) since we use system chromium
RUN npm ci --ignore-scripts

COPY . .

EXPOSE 3000

# Constrain memory for RPi (leave room for FlareSolverr + OS)
CMD ["node", "--max-old-space-size=512", "src/index.js"]
