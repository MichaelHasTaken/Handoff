import { createClient } from 'jsr:@supabase/supabase-js@2'

const BUCKET     = 'uploads'
const SIGNED_SEC = 600                     // app.js 의 SIGNED_SEC 과 맞추기
const CODE_RE    = /^[A-HJ-NP-Z2-9]{8}$/    // SQL check 와 동일

const ALLOWED_ORIGIN = 'https://your-app.com'
const cors = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)   // ← 이 줄 추가

  try {
  let body: unknown
  try {                                  // 안쪽: JSON 파싱만 → 400
    body = await req.json()
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }
  
  const code = (body as { code?: unknown }).code

    if (typeof code !== 'string' || !CODE_RE.test(code)) {
      return json({ error: 'invalid_code' }, 400)
    }

    // service_role → RLS 우회. 이 key 는 브라우저에 노출되지 않는다.
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // 1) code 검증 + 소진 (atomic)
    const { data, error } = await admin.rpc('claim_file', { p_code: code })
    if (error) throw error
    if (!data || data.length === 0) return json({ error: 'not_found' }, 404)

    const { filename, storage_path } = data[0]

    // 2) 검증 통과 후에만 signed URL 발급
    const signed = await admin.storage
      .from(BUCKET)
      .createSignedUrl(storage_path, SIGNED_SEC, { download: filename })
    if (signed.error) throw signed.error

    return json({ url: signed.data.signedUrl, filename, expires_in: SIGNED_SEC })

  } catch (e) {
    console.error(e)
    return json({ error: 'server_error' }, 500)
  }
})
