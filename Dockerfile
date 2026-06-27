FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/seed-data/data /app/seed-data/reports \
  && cp -R data/. /app/seed-data/data/ \
  && cp -R reports/. /app/seed-data/reports/

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV HOST=0.0.0.0
ENV PORT=4173

EXPOSE 4173

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "web"]
