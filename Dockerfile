FROM node:22-alpine

ENV NODE_ENV=production PORT=5000
WORKDIR /app

# Secrets are injected at runtime by Compose; never bake .env or API keys into this image.
COPY --chown=node:node package.json server.js ./
USER node

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
