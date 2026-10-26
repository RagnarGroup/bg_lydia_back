# LYD-53: node:*-slim (Debian/glibc), no alpine -- el binario de ffmpeg-static
# esta compilado contra glibc y falla en musl (Alpine).
FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js opus-tags.js ./

EXPOSE 4040
CMD ["node", "server.js"]
