ARG BUILD_FROM
FROM ${BUILD_FROM}

USER root

# Prevent Puppeteer from downloading its own Chromium
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_DISABLE_HEADLESS_WARNING=true \
    NODE_ENV=production

# Node + runtime deps for Chromium on Alpine/HA add-ons
RUN apk add --no-cache \
    nodejs npm bash \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

WORKDIR /app

# Copy addon rootfs (this places your app files under /app, incl package.json)
COPY rootfs /

# Install ONLY what's in /app/package.json (puppeteer-core, otpauth, dotenv, axios)
# IMPORTANT: do NOT install "puppeteer"
RUN npm install --omit=dev

RUN chmod a+x /app/script.sh

CMD ["/app/script.sh"]
