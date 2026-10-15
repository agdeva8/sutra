# Ops setup checklist

Things the code cannot do for you. Each item is a setting or a one-off step in Vercel or Supabase.

## Storage (uploads, Scratch photos, Memories photos)

- [ ] Set `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` and `SUPABASE_BUCKET` (default `goalcoach`) on the API project, and create the bucket.
- [ ] Allow the web origin in the bucket's CORS settings (Supabase → Storage → the bucket → Configuration). Allowed origins: the web app's origin. Methods: `PUT, POST, GET, HEAD`. Headers: `content-type, x-upsert`. Without this the browser's direct upload is blocked by CORS and every file falls back to the proxied route — which the serverless request-body cap then rejects well below the 20 MB limit, so the largest files are the ones that fail.
- [ ] Apply migration `20261015_0900_source_blobs`. Without Supabase, a serverless host stores bytes in the `source_blobs` table instead (a safety net, not a place for 20 MB files).
- [ ] Files uploaded before this fix lived on a function instance's disk and are gone. Re-upload them.

## Database latency

- [ ] Set a `regions` value in the API project's `vercel.json` close to the Supabase database (for example `"regions": ["bom1"]` if the database is in Mumbai). It is not set in the repo because the database region is not recorded here.
- [ ] Confirm `DATABASE_URL` uses the Supabase pooler on port 6543. Use the session pooler on 5432 only for `alembic` (`DATABASE_URL_UNPOOLED`).
- [ ] Note the extra hop: `apps/web/vercel.json` rewrites `/api/*` to `https://sutra-api-neon.vercel.app`, so every API call goes browser -> web project -> API project. Putting both in the same region keeps it cheap; serving the API from the web origin removes it.

## Migrations to apply (not applied by any code)

- [ ] `20261015_1200_user_prefs`: adds `users.preferences` (theme and text size). Run `alembic upgrade head` against the direct (unpooled) URL.

## Security headers

- [ ] The full Content-Security-Policy in `apps/web/vercel.json` is report-only. After a preview deploy shows no violations in the browser console, move it from `Content-Security-Policy-Report-Only` to `Content-Security-Policy`.
