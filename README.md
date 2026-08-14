# Handoff

One-time file transfer. Upload a file, get an 8-character claim code, hand the code
to one person. The first download consumes it.

**[Live demo](https://your-app.vercel.app)** · Demo only — don't upload anything sensitive.

<!-- 스크린샷을 넣으면 좋습니다:  ![screenshot](docs/screenshot.png) -->

## How it works

```
Upload    browser ──► Storage (file)
                  ──► Postgres (code, description, path)

Download  browser ──[code]──► peek_file()        description only
                  ──[code]──► Edge Function ──► claim_file() + signed URL
                  ◄──[file]── Storage
```

No accounts, no sessions. The code is the only credential.

The file itself never passes through the Edge Function — the function returns a
short-lived signed URL and the browser fetches from Storage directly.

## Security model

There is no backend server, so the browser talks to Supabase directly. Everything
the anonymous key can do is defined by Postgres RLS policies:

| | anon can |
|---|---|
| `files` table | `INSERT` only — no `SELECT`, so codes can't be enumerated |
| Storage bucket | `INSERT` only — no `SELECT`, so files can't be listed |
| `peek_file()` | call with a valid code — returns metadata, never the storage path |
| `claim_file()` | **no** — Edge Function only |

Signed URLs are issued by an Edge Function holding `service_role`, which is injected
at runtime and never reaches the client. Because the browser has no Storage read
permission, the only path from a code to a file goes through that function.

A few smaller decisions:

- **Codes** are 8 chars from a 32-symbol alphabet (`I`, `O`, `0`, `1` excluded for
  legibility) generated with `crypto.getRandomValues` — 32⁸ ≈ 1.1 trillion.
- **Consumption is atomic** (`UPDATE ... RETURNING`), so two simultaneous claims
  can't both win.
- **`storage_path` is `UNIQUE`.** A signed URL contains its object path in plain
  text; without this, a leaked URL's path could be re-registered under a new code
  to regain access after expiry.
- **Downloads force `Content-Disposition: attachment`**, so uploaded `.html` / `.svg`
  can't be rendered in a browser. This is why file extensions aren't restricted.
- **All user-supplied text is rendered with `textContent`**, never `innerHTML`.

## Limitations

- **Nothing is deleted automatically.** `expires_at` and `downloaded_at` only gate
  lookups; rows and files remain. Manual cleanup, or a scheduled job (planned).
- **No rate limiting.** The Edge Function is public. This can't leak data, but it
  can burn the free-tier quota.
- **A leaked signed URL works until it expires** (10 minutes). The function controls
  issuance, not use — the URL is a bearer token by design.
- **Anonymous uploads are open**, which is the point, but there's no moderation or
  abuse reporting. Hence: demo only.

## Setup

Requires a Supabase project. Nothing to build — four static files.

1. Run [`schema.sql`](schema.sql) in the Supabase SQL editor.
2. Create a Storage bucket named `uploads` — **private**, 50 MB file limit.
3. Deploy the Edge Function:
   ```
   npx supabase link --project-ref <your-ref>
   npx supabase functions deploy claim --use-api
   ```
4. Fill in `config.js` with your project URL and publishable key
   (Settings → API). This key is meant to be public.
5. Serve the folder over HTTP — e.g. VS Code Live Server.
   `file://` won't work; ES modules need a real origin.

Deploy by pointing Vercel or any static host at the repo. No build command,
no output directory.

> Fork and deploy without step 4 and you'll be using **my** Supabase project as
> your backend.

### Stack

Vanilla HTML/CSS/JS, no framework or build step ·
Supabase (Postgres, Storage, Edge Functions on Deno) ·
Archivo + Space Mono
