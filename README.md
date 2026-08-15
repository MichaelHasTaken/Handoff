# Handoff

One-time file transfer. Upload a file, get an 8-character claim code, hand the code
to one person. The first download consumes it.

**[Live demo](https://handoff-zeta-seven.vercel.app)** · Demo only — don't upload anything sensitive.

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

The publishable key is in the client by design — it's meant to be public, and
it's visible in the `apikey` request header regardless of where it's stored.
The security boundary is Postgres RLS, not key secrecy.

Verified from the browser console using the anon client, with files present in
the bucket:

| attempt | result |
|---|---|
| `storage.from('uploads').list()` | `data: []` |
| `storage.createSignedUrl(...)` | `Object not found` |
| `from('files').select('*')` | `permission denied` |
| `rpc('claim_file', ...)` | `permission denied` |
| `rpc('peek_file', <valid code>)` | `200` — works as intended |

`anon` can only `INSERT` — into `files` and into the bucket. It cannot list,
read, update or delete either. Signed URLs are issued by an Edge Function holding
`service_role`, injected at runtime and never sent to the client. Because the
browser has no Storage read permission, the only path from a code to a file runs
through that function.

<details>
<summary>Smaller decisions</summary>

- **Codes** are 8 chars from a 32-symbol alphabet (`I`, `O`, `0`, `1` excluded for
  legibility) generated with `crypto.getRandomValues` — 32⁸ ≈ 1.1 trillion.
- **Consumption is atomic** (`UPDATE ... RETURNING`), so two simultaneous claims
  can't both win.
- **`storage_path` is `UNIQUE`.** A signed URL contains its object path in plain
  text; without this, a leaked URL's path could be re-registered under a new code
  to regain access after expiry.
- **Files are served from the Storage origin, not the app origin**, and downloads
  set `Content-Disposition: attachment` with an opaque content type. An uploaded
  `.html` / `.svg` therefore can't become stored XSS against this app even if a
  browser chooses to render it.
- **All user-supplied text is rendered with `textContent`**, never `innerHTML`.

</details>

## Limitations

- **Nothing is deleted automatically.** `expires_at` and `downloaded_at` only gate
  lookups; rows and files remain. Manual cleanup, or a scheduled job (planned).
- **No rate limiting.** The Edge Function is public. This can't leak data, but it
  can burn the free-tier quota.
- **A leaked signed URL works until it expires** (5 minutes). The function controls
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
