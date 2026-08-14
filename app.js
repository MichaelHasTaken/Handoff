import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const BUCKET = "uploads";
const MAX_BYTES = 49 * 1024 * 1024; // SQL 의 52428800 보다 살짝 낮게
const MAX_DESC = 200;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32자, I/O/0/1 제외
const CODE_RE = /^[A-HJ-NP-Z2-9]{8}$/; // SQL check 와 동일

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/* ─── elements ────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

const els = {
  tabSend: $("tabSend"),
  tabClaim: $("tabClaim"),
  panelSend: $("panelSend"),
  panelStub: $("panelStub"),
  panelClaim: $("panelClaim"),

  drop: $("drop"),
  fileInput: $("fileInput"),
  dropTitle: $("dropTitle"),
  dropNote: $("dropNote"),
  descInput: $("descInput"),
  descCount: $("descCount"),
  sendBtn: $("sendBtn"),
  sendMsg: $("sendMsg"),

  stubCode: $("stubCode"),
  stubFile: $("stubFile"),
  stubExpiry: $("stubExpiry"),
  copyCodeBtn: $("copyCodeBtn"),
  copyLinkBtn: $("copyLinkBtn"),
  againBtn: $("againBtn"),

  codeInput: $("codeInput"),
  lookupBtn: $("lookupBtn"),
  claimMsg: $("claimMsg"),
  found: $("found"),
  foundDesc: $("foundDesc"),
  foundFile: $("foundFile"),
  foundSize: $("foundSize"),
  downloadBtn: $("downloadBtn"),
  done: $("done"),
  doneName: $("doneName"),
  retryBtn: $("retryBtn"),
  retryHint: $("retryHint"),
};

let pickedFile = null;
let pendingCode = null; // 조회 성공한 code (아직 소진 안 됨)
let backupUrl = null; // claim 후 재시도용 signed URL

const DROP_IDLE = {
  title: els.dropTitle.textContent,
  note: els.dropNote.textContent,
};
/* ─── helpers ─────────────────────────────────────── */

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => CODE_CHARS[b % 32]).join("");
}

// Storage key 에는 ASCII 만 넣는다. 원본 이름은 DB 에 따로 보관.
function safeName(name) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).replace(/[^a-zA-Z0-9.]/g, "") : "";
  const base = (dot > 0 ? name.slice(0, dot) : name)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 60);
  return (base || "file") + ext;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024,
    i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (v < 10 ? v.toFixed(1) : Math.round(v)) + " " + units[i];
}

function show(el, on = true) {
  el.hidden = !on;
}

function say(el, text, kind = "error") {
  el.textContent = text; // textContent = XSS 안전
  el.className = "msg msg-" + kind;
  show(el, true);
}

function clear(el) {
  el.textContent = "";
  show(el, false);
}

function busy(btn, on, label) {
  btn.disabled = on;
  if (on) {
    btn.dataset.idle = btn.textContent;
    btn.textContent = label;
  } else if (btn.dataset.idle) {
    btn.textContent = btn.dataset.idle;
  }
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const was = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => {
      btn.textContent = was;
    }, 1400);
  } catch {
    say(
      els.sendMsg,
      "Clipboard blocked. Select the code and copy it manually.",
    );
  }
}

function download(url) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ─── tabs ────────────────────────────────────────── */

function openTab(which) {
  const sending = which === "send";
  els.tabSend.classList.toggle("is-active", sending);
  els.tabClaim.classList.toggle("is-active", !sending);
  show(els.panelSend, sending && els.panelStub.hidden);
  show(els.panelStub, sending && !els.panelStub.hidden);
  show(els.panelClaim, !sending);
}

els.tabSend.onclick = () => openTab("send");
els.tabClaim.onclick = () => openTab("claim");

/* ─── send: pick a file ───────────────────────────── */

function pick(file) {
  clear(els.sendMsg);
  if (!file) return;

  if (file.size === 0) {
    say(els.sendMsg, "That file is empty.");
    return;
  }
  if (file.size > MAX_BYTES) {
    say(els.sendMsg, `That file is ${fmtSize(file.size)}. The limit is 49 MB.`);
    return;
  }

  pickedFile = file;
  els.dropTitle.textContent = file.name;
  els.dropNote.textContent = fmtSize(file.size);
  els.drop.classList.add("has-file");
}

els.fileInput.onchange = () => pick(els.fileInput.files[0]);

els.drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.drop.classList.add("is-over");
});
els.drop.addEventListener("dragleave", () =>
  els.drop.classList.remove("is-over"),
);
els.drop.addEventListener("drop", (e) => {
  e.preventDefault();
  els.drop.classList.remove("is-over");
  pick(e.dataTransfer.files[0]);
});

els.descInput.maxLength = MAX_DESC; // HTML 대신 JS가 설정

function updateCount() {
  if (els.descInput.value.length > MAX_DESC) {
    els.descInput.value = els.descInput.value.slice(0, MAX_DESC);
  }
  els.descCount.textContent = `${els.descInput.value.length}/${MAX_DESC}`;
}

els.descInput.oninput = updateCount;
updateCount(); // 초기 표시

/* ─── send: upload ────────────────────────────────── */

els.sendBtn.onclick = async () => {
  clear(els.sendMsg);

  if (!pickedFile) return say(els.sendMsg, "Choose a file first.");
  const description = els.descInput.value.trim() || "No description provided";
  const code = makeCode();
  const path = `${crypto.randomUUID()}/${safeName(pickedFile.name)}`;

  busy(els.sendBtn, true, "Uploading…");
  try {
    // 1. Storage 에 파일
    const up = await supabase.storage.from(BUCKET).upload(path, pickedFile);
    if (up.error) throw up.error;

    // 2. DB 에 메타데이터
    const ins = await supabase.from("files").insert({
      code,
      description,
      filename: pickedFile.name.normalize("NFC"),
      size_bytes: pickedFile.size,
      storage_path: path,
    });

    // insert 가 깨지면 올린 파일을 되돌린다 (orphan 방지)
    if (ins.error) {
      const rm = await supabase.storage.from(BUCKET).remove([path]);
      if (rm.error) console.warn("orphan left behind:", path, rm.error.message);
      throw ins.error;
    }

    showStub(code, pickedFile);
  } catch (e) {
    console.error(e);
    say(els.sendMsg, "Upload failed: " + (e.message || "unknown error"));
  } finally {
    busy(els.sendBtn, false);
  }
};

function showStub(code, file) {
  els.stubCode.textContent = code;
  els.stubFile.textContent = `${file.name} · ${fmtSize(file.size)}`;
  els.stubExpiry.textContent = new Date(
    Date.now() + 24 * 3600 * 1000,
  ).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const link = `${location.origin}${location.pathname}?code=${code}`;
  els.copyCodeBtn.onclick = () => copy(code, els.copyCodeBtn);
  els.copyLinkBtn.onclick = () => copy(link, els.copyLinkBtn);

  show(els.panelSend, false);
  show(els.panelStub, true);
}

els.againBtn.onclick = () => {
  pickedFile = null;
  els.fileInput.value = "";
  els.descInput.value = "";
  els.dropTitle.textContent = DROP_IDLE.title;
  els.dropNote.textContent = DROP_IDLE.note;
  els.drop.classList.remove("has-file");
  updateCount();
  clear(els.sendMsg);
  show(els.panelStub, false);
  show(els.panelSend, true);
};

/* ─── claim: normalise input ──────────────────────── */

els.codeInput.oninput = () => {
  els.codeInput.value = els.codeInput.value
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, "") // 허용 문자만 남김
    .slice(0, 8);
};

els.codeInput.onkeydown = (e) => {
  if (e.key === "Enter") els.lookupBtn.click();
};

/* ─── claim: peek (소진하지 않음) ─────────────────── */

els.lookupBtn.onclick = async () => {
  clear(els.claimMsg);
  els.found.classList.remove("is-torn");
  show(els.found, false);
  show(els.done, false);

  const code = els.codeInput.value.trim();
  if (!CODE_RE.test(code)) {
    return say(els.claimMsg, "A claim code is 8 characters. Check for a typo.");
  }

  busy(els.lookupBtn, true, "Looking up…");
  try {
    const { data, error } = await supabase.rpc("peek_file", { p_code: code });
    if (error) throw error;

    if (!data || data.length === 0) {
      return say(
        els.claimMsg,
        "No file for that code. It may already be claimed, or it expired.",
      );
    }

    const row = data[0];
    pendingCode = code;
    els.foundDesc.textContent = row.description;
    els.foundFile.textContent = row.filename;
    els.foundSize.textContent = fmtSize(row.size_bytes);
    show(els.found, true);
  } catch (e) {
    console.error(e);
    say(els.claimMsg, "Lookup failed: " + (e.message || "unknown error"));
  } finally {
    busy(els.lookupBtn, false);
  }
};

/* ─── claim: consume + download ───────────────────── */

els.downloadBtn.onclick = async () => {
  if (!pendingCode) return;
  clear(els.claimMsg);

  busy(els.downloadBtn, true, "Preparing…");
  try {
    // Edge Function 이 code 검증 + signed URL 발급을 한 번에 처리
    const { data, error } = await supabase.functions.invoke("claim", {
      body: { code: pendingCode },
    });

    if (error) {
      // 함수가 4xx/5xx 를 반환하면 여기로 온다
      let reason = "";
      try {
        reason = (await error.context?.json())?.error;
      } catch {
        /* body 없음 */
      }

      show(els.found, false);
      return say(
        els.claimMsg,
        reason === "not_found"
          ? "Someone claimed this file first, or it expired."
          : "Download failed. Please try again.",
      );
    }

    backupUrl = data.url;
    download(backupUrl);
    pendingCode = null;
    els.doneName.textContent = data.filename;
    els.retryHint.textContent = `This backup link works for ${Math.round(data.expires_in / 60)} minutes, in case the download failed.`;
    els.retryBtn.onclick = () => download(backupUrl);

    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      show(els.found, false);
      show(els.done, true);
    } else {
      els.found.classList.add("is-torn");
      setTimeout(() => {
        show(els.found, false);
        show(els.done, true);
      }, 560);
    }
  } catch (e) {
    console.error(e);
    say(els.claimMsg, "Download failed: " + (e.message || "unknown error"));
  } finally {
    busy(els.downloadBtn, false);
  }
};

/* ─── ?code=XXXXXXXX 로 들어온 경우 ───────────────── */

const urlCode = new URLSearchParams(location.search).get("code");
if (urlCode) {
  els.codeInput.value = urlCode
    .toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, "")
    .slice(0, 8);
  openTab("claim");
  if (CODE_RE.test(els.codeInput.value)) els.lookupBtn.click();
}
