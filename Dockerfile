# Bonus 17: an image that runs the API. The database lives on a volume (/data).
FROM denoland/deno:2.6.3
WORKDIR /app

# deno.json holds the imports AND the "unstable" setting (Deno KV and Deno.cron)
COPY deno.json deno.lock* ./
COPY src ./src
# the SQL migration files that migrate() applies at start-up
COPY drizzle ./drizzle
# download and compile the dependencies now, so that `docker run` starts at once
RUN deno cache src/main.ts

# the database, the KV cache and the uploads go to the volume; the "deno" user may write there
RUN mkdir /data && chown deno:deno /data
USER deno

ENV DATABASE_URL=file:/data/tasks.db KV_PATH=/data/kv.db UPLOAD_DIR=/data/uploads PORT=8000
EXPOSE 8000

# One flag per thing the API really does (see the README, Bonus 17).
CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-ffi", "--allow-sys", "src/main.ts"]
