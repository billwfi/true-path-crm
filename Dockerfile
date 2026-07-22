# True Path CRM — production container image.
# Serves the static web/ site and runs the Netlify functions via server.js.
FROM node:20-alpine

# dumb-init for correct signal handling (graceful shutdown under ACA).
RUN apk add --no-cache dumb-init

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# Install production deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code.
COPY server.js ./
COPY netlify ./netlify
COPY web ./web

EXPOSE 8080

# Run as the built-in non-root user.
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
