# [Cat 15] The "latest" tag — non-reproducible builds. Good luck rolling back.
FROM node:latest

# [Cat 15] Run as root. Why not.
WORKDIR /app

# [Cat 7/9] Hardcoded secrets baked straight into the image layers, forever.
ENV DB_PASSWORD=p@ssw0rd-in-plaintext
ENV STRIPE_SECRET_KEY=sk_live_totally_fake_do_not_panic_0000
ENV CHAOS_LEVEL=10

# Copy everything, including node_modules, .env, and any secrets lying around.
COPY . .

RUN npm install

EXPOSE 3000

# No HEALTHCHECK. No graceful shutdown. No resource awareness.
CMD ["node", "backend/server.js"]
