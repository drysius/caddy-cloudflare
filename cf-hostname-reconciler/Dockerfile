FROM node:22-alpine

WORKDIR /app

# No runtime dependencies: only the source and manifest are needed.
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.json()).then(d=>process.exit(d.healthy?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "src/index.js"]
