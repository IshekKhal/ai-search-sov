# Use official lightweight Apify Node.js base image (no heavy Playwright/Chrome browser stack)
FROM apify/actor-node:20

# Switch to root user to allow global package installation
USER root

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install pnpm globally and project production dependencies
RUN npm install -g pnpm && pnpm install --frozen-lockfile --prod

# Copy application source code
COPY . ./

# Switch back to non-root user
USER myuser

# Start command
CMD ["pnpm", "start"]
