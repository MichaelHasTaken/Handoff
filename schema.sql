-- Handoff — database schema
--
-- 위에서 아래로 실행하세요.
-- 섹션 5 전에 Dashboard 에서 'uploads' bucket 을 Private / 50MB limit 으로 생성해야 합니다.
-- 이 파일만으로는 동작하지 않습니다. 'claim' Edge Function 배포가 필요합니다.


-- ── 1. TABLE ──────────────────────────────────────────────

create table files (
  code          text primary key check (code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  description   text        not null,
  filename      text        not null,
  size_bytes    bigint      not null,
  storage_path  text        not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '24 hours',
  downloaded_at timestamptz,

  -- signed URL 에는 경로가 평문으로 들어 있다. 이 제약이 없으면 유출된 URL 의
  -- 경로를 새 code 로 재등록해 만료 후에도 접근을 회복할 수 있다.
  constraint files_storage_path_unique unique (storage_path)
);


-- ── 2. RLS ────────────────────────────────────────────────
-- INSERT policy 만 존재. select/update/delete 는 policy 가 없어 전부 차단된다.

alter table files enable row level security;

create policy "anon can upload" on files
  for insert to anon
  with check (
    length(description) between 1 and 200
    and length(filename) between 1 and 200
    and size_bytes between 1 and 52428800            -- 50 MiB

    -- 클라이언트가 먼 미래를 지정해 영구 저장을 점유하는 것을 막는다.
    -- 24h 로 두면 default 와 등호 경계에 걸려 깨지기 쉽다.
    and expires_at <= now() + interval '25 hours'
  );


-- ── 3. peek_file ──────────────────────────────────────────
-- 설명만 반환하고 소진하지 않는다. storage_path 를 반환하지 않는 것이 핵심.

create or replace function peek_file(p_code text)
returns table (description text, filename text, size_bytes bigint)
language sql
security definer
set search_path = public
stable
as $$
  select f.description, f.filename, f.size_bytes
    from files f
   where f.code = p_code
     and f.downloaded_at is null
     and f.expires_at > now();
$$;


-- ── 4. claim_file ─────────────────────────────────────────
-- update ... returning 이 atomic 하므로 동시 요청 시 한 명만 성공한다.
-- anon 은 호출할 수 없다. Edge Function 이 service_role 로 호출한다.

create or replace function claim_file(p_code text)
returns table (filename text, storage_path text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update files f
     set downloaded_at = now()
   where f.code = p_code
     and f.downloaded_at is null
     and f.expires_at > now()
  returning f.filename, f.storage_path;
end;
$$;


-- ── 5. 권한 ───────────────────────────────────────────────
-- Data API 의 auto-expose 가 anon 에게 7개 권한을 부여한다.
-- TRUNCATE 는 RLS 가 막지 못하므로 반드시 회수한다.

revoke all on table files from anon;
grant insert on table files to anon;

revoke all on function peek_file(text)  from public;
revoke all on function claim_file(text) from public;

grant  execute on function peek_file(text)  to anon;
revoke execute on function claim_file(text) from anon;


-- ── 6. STORAGE ────────────────────────────────────────────
-- 'uploads' bucket 을 Private / 50MB limit 으로 먼저 생성하세요.
-- must be owner of table objects 에러가 나면
-- Dashboard → Storage → Policies 에서 UI 로 만드세요.

create policy "anon can upload files"
  on storage.objects for insert to anon
  with check (bucket_id = 'uploads');

-- SELECT policy 를 만들지 않는다. 이것이 이 스키마의 핵심.
--
-- select 권한은 createSignedUrl() 과 list() 에 동시에 적용되며 RLS 로 둘을
-- 분리할 수 없다. anon 에게 주면 code 없이 전체 파일 목록을 열거하고 스스로
-- URL 을 발급해 흔적 없이 모든 파일을 받아갈 수 있다.
--
-- 대신 service_role 을 가진 Edge Function 이 발급을 담당한다.
-- service_role 은 BYPASSRLS 이므로 policy 유무와 무관하게 동작한다.

-- DELETE policy 도 없음 = 아무도 남의 파일을 지울 수 없다.


-- ── 7. 참고 ───────────────────────────────────────────────

-- Edge Function (필수)
--   npx supabase functions deploy claim --use-api
--   입력은 code 하나뿐. 경로를 입력으로 받게 만들면 모든 파일을 요청할 수 있는
--   공개 API 가 된다.
--   signed URL 에 &download= 를 반드시 붙일 것. Content-Disposition: attachment 로
--   .html/.svg 렌더링을 막는다. { download: filename } 옵션은 이중 인코딩 버그가 있다.

-- 자동 삭제 (미구현)
--   expires_at 과 downloaded_at 은 조회를 막는 필터일 뿐이며 row 와 파일은 남는다.
--   storage.objects 를 SQL 로 직접 delete 하면 메타데이터만 지워지고 파일이 남는다.
--   삭제는 Storage API 를 경유해야 하며 service_role 이 필요하다.
--
--   수동 정리 — 순서를 바꾸면 경로를 잃어 파일이 영구 고아가 된다:
--     select storage_path from files
--      where downloaded_at is not null or expires_at < now();   -- ① Storage 에서 삭제
--     delete from files
--      where downloaded_at is not null or expires_at < now();   -- ② 그 다음 row

-- 상태 확인
--   select tablename, policyname, cmd, roles from pg_policies
--    where schemaname in ('public','storage');
--   -- 기대: files:INSERT, objects:INSERT 2개. objects:SELECT 가 보이면 안 됨.
