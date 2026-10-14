from node:20-bookworm-slim
workdir /app

copy . .
run apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && npm install

expose 11000
cmd ["npm", "start"]
