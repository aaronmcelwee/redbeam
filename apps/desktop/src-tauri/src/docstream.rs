//! The `rbdoc:` protocol: a drawing on disk, read a byte range at a time.
//!
//! The viewer used to get its PDF as one blob: the whole file crossed the IPC
//! hop and sat in memory twice before PDFium saw a byte, so a 470 MB
//! specifications book cost about a gigabyte just to open, and anything past
//! 256 MB was refused outright. PDFium does not need the whole file: it reads
//! the trailer, the cross-reference table and then whatever objects the page
//! being drawn uses. So the window asks for a stream (`project_stream_document`)
//! and gets back a token, and the PDF worker hands PDFium a loader that fetches
//! `rbdoc://localhost/<token>` with a `Range` header for each block it wants.
//! Nothing here limits the size of the file.
//!
//! The file is opened once, when the stream is made, and every range is read
//! from that handle. A save that replaces the file (write to a temporary file,
//! rename over) leaves this handle on the old file, which is what PDFium parsed,
//! instead of serving it the new file's bytes at the old file's offsets. A save
//! that appends leaves every offset PDFium knows about unchanged.
//!
//! Only files the window asked for are served, by token, and only inside the
//! folder it named (the same `resolve_inside` check as `project_read_document`).

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::http::{header, Request, Response, StatusCode};

use crate::project::{canonical_project_root, resolve_inside};

pub const SCHEME: &str = "rbdoc";

#[derive(Default)]
pub struct DocStreams {
    open: Mutex<HashMap<String, Arc<Mutex<File>>>>,
    next: AtomicU64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamInfo {
    /// Goes after `rbdoc://localhost/`.
    pub token: String,
    pub size: u64,
}

/// Open a drawing for range reads, and say how to reach it.
#[tauri::command]
pub fn project_stream_document(
    state: tauri::State<'_, DocStreams>,
    path: String,
    relative_path: String,
) -> Result<StreamInfo, String> {
    let root = canonical_project_root(Path::new(&path));
    let target = resolve_inside(&root, &relative_path)?;
    let file = File::open(&target).map_err(|e| format!("{relative_path}: {e}"))?;
    let metadata = file.metadata().map_err(|e| format!("{relative_path}: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("{relative_path} is not a file"));
    }
    let n = state.next.fetch_add(1, Ordering::Relaxed);
    // Unguessable enough that one page cannot read another's file by counting.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let token = format!("{n:x}-{:x}.pdf", nanos ^ (std::process::id() as u128) << 64);
    state
        .open
        .lock()
        .map_err(|_| "stream table poisoned".to_string())?
        .insert(token.clone(), Arc::new(Mutex::new(file)));
    Ok(StreamInfo { token, size: metadata.len() })
}

/// SHA-256 of the file a stream reads, hashed through its own handle: the
/// version an update built from this stream must be appended to
/// (`project_append_document` checks it against the file on disk).
#[tauri::command]
pub async fn project_stream_fingerprint(state: tauri::State<'_, DocStreams>, token: String) -> Result<String, String> {
    let file = state
        .open
        .lock()
        .map_err(|_| "stream table poisoned".to_string())?
        .get(&token)
        .cloned()
        .ok_or_else(|| "no such document stream".to_string())?;
    tauri::async_runtime::spawn_blocking(move || hash_handle(&file))
        .await
        .map_err(|e| e.to_string())?
}

fn hash_handle(file: &Mutex<File>) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = file.lock().map_err(|_| "stream poisoned".to_string())?;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut chunk = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut chunk).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&chunk[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// A copy of a stream's file with `tail` (an incremental update built from the
/// same stream) appended: "save a copy", a marked-up export or an AI app's
/// working copy of a set too big to hold in memory. The file is copied from
/// the stream's own handle, so the copy is the version the update was built
/// against even if the file on disk has been replaced since. The raw body is
/// the tail (may be empty). Where it goes is `x-redbeam-dest`:
///
/// - `dialog`: a native Save As (`x-redbeam-default-name`, optional
///   `x-redbeam-filter-name` and comma-separated `x-redbeam-extensions`).
///   Returns null when the person cancels.
/// - `project`: a new file inside the project (`x-redbeam-path`,
///   `x-redbeam-relative-path`), never over anything already there.
/// - `path`: an absolute export path (`x-redbeam-target`,
///   `x-redbeam-overwrite`), with the same rules as `write_export_file`.
///
/// Returns where it was written.
#[tauri::command]
pub async fn project_stream_copy(
    app: tauri::AppHandle,
    state: tauri::State<'_, DocStreams>,
    request: tauri::ipc::Request<'_>,
) -> Result<Option<String>, String> {
    use crate::project::{export_target_ok, percent_decode};
    let header = |name: &str| -> Option<String> {
        request.headers().get(name).and_then(|v| v.to_str().ok()).and_then(percent_decode)
    };
    let need = |name: &str| header(name).ok_or_else(|| format!("missing {name}"));
    let token = need("x-redbeam-token")?;
    let tail: Vec<u8> = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("the update must be sent as the raw body".to_string()),
    };
    let file = state
        .open
        .lock()
        .map_err(|_| "stream table poisoned".to_string())?
        .get(&token)
        .cloned()
        .ok_or_else(|| "no such document stream".to_string())?;
    let dest = match need("x-redbeam-dest")?.as_str() {
        "dialog" => {
            use tauri_plugin_dialog::DialogExt;
            let mut dialog = app.dialog().file().set_file_name(need("x-redbeam-default-name")?).set_title("Save");
            if let (Some(name), Some(exts)) = (header("x-redbeam-filter-name"), header("x-redbeam-extensions")) {
                let list: Vec<String> = exts.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
                let refs: Vec<&str> = list.iter().map(String::as_str).collect();
                dialog = dialog.add_filter(name, &refs);
            }
            let Some(picked) = dialog.blocking_save_file() else { return Ok(None) };
            let path = picked.into_path().map_err(|e| format!("the chosen location is not a file path: {e}"))?;
            // The dialog has asked about replacing an existing file.
            Dest::Replace(path)
        }
        "project" => {
            let root = canonical_project_root(Path::new(&need("x-redbeam-path")?));
            let relative = need("x-redbeam-relative-path")?;
            let target = resolve_inside(&root, &relative)?;
            if let Some(dir) = target.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("could not make the folder: {e}"))?;
            }
            Dest::New(target)
        }
        "path" => {
            let path = std::path::PathBuf::from(need("x-redbeam-target")?);
            let overwrite = header("x-redbeam-overwrite").as_deref() == Some("1");
            export_target_ok(&path, overwrite)?;
            if overwrite { Dest::Replace(path) } else { Dest::New(path) }
        }
        other => return Err(format!("unknown destination {other}")),
    };
    tauri::async_runtime::spawn_blocking(move || copy_with_tail(&file, &dest, &tail).map(|p| Some(p.display().to_string())))
        .await
        .map_err(|e| e.to_string())?
}

pub enum Dest {
    /// Refuse if anything is there.
    New(std::path::PathBuf),
    /// Written beside, then renamed over whatever is there.
    Replace(std::path::PathBuf),
}

pub fn copy_with_tail(src: &Mutex<File>, dest: &Dest, tail: &[u8]) -> Result<std::path::PathBuf, String> {
    use std::io::Write;
    let (target, writing) = match dest {
        Dest::New(p) => (p.clone(), p.clone()),
        Dest::Replace(p) => (p.clone(), p.with_extension("redbeam-tmp")),
    };
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(matches!(dest, Dest::New(_)))
        .create(true)
        .truncate(true)
        .open(&writing)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                "a file with that name is already there".to_string()
            } else {
                format!("could not create {}: {e}", writing.display())
            }
        })?;
    let written = (|| -> std::io::Result<()> {
        let mut src = src.lock().map_err(|_| std::io::Error::other("stream poisoned"))?;
        src.seek(SeekFrom::Start(0))?;
        std::io::copy(&mut *src, &mut out)?;
        out.write_all(tail)?;
        out.sync_all()
    })();
    drop(out);
    if let Err(e) = written {
        let _ = std::fs::remove_file(&writing);
        return Err(format!("could not write {}: {e}", target.display()));
    }
    if writing != target {
        if let Err(e) = std::fs::rename(&writing, &target) {
            let _ = std::fs::remove_file(&writing);
            return Err(format!("could not write {}: {e}", target.display()));
        }
    }
    Ok(target)
}

/// Close a stream: the viewer that used it is gone.
#[tauri::command]
pub fn project_stream_release(state: tauri::State<'_, DocStreams>, token: String) {
    if let Ok(mut open) = state.open.lock() {
        open.remove(&token);
    }
}

/// `bytes=a-b`, `bytes=a-` or `bytes=-n`, clamped to the file. `None` for a
/// range that does not overlap it; a header that is not a single byte range
/// is treated as no header (the whole file).
pub fn parse_range(value: &str, size: u64) -> Option<Option<(u64, u64)>> {
    let Some(spec) = value.trim().strip_prefix("bytes=") else { return Some(None) };
    if spec.contains(',') {
        return Some(None);
    }
    let Some((a, b)) = spec.split_once('-') else { return Some(None) };
    let (a, b) = (a.trim(), b.trim());
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        (size.saturating_sub(n), size.checked_sub(1)?)
    } else {
        let start: u64 = a.parse().ok()?;
        let end: u64 = if b.is_empty() { size.checked_sub(1)? } else { b.parse::<u64>().ok()?.min(size.checked_sub(1)?) };
        (start, end)
    };
    if start >= size || start > end {
        return None;
    }
    Some(Some((start, end)))
}

fn cors(builder: tauri::http::response::Builder) -> tauri::http::response::Builder {
    // The worker's origin is the app's own (tauri.localhost or tauri://), not
    // this scheme's, so the read is cross-origin and Range is not a simple
    // header everywhere.
    builder
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Headers", "Range")
        .header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
        .header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")
}

fn plain(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    cors(Response::builder().status(status))
        .header(header::CONTENT_TYPE, "text/plain")
        .body(message.as_bytes().to_vec())
        .unwrap_or_default()
}

/// Answer one request. Runs off the main thread (see `lib.rs`).
pub fn respond(streams: &DocStreams, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() == "OPTIONS" {
        return cors(Response::builder().status(StatusCode::NO_CONTENT)).body(Vec::new()).unwrap_or_default();
    }
    let token = request.uri().path().trim_start_matches('/').to_string();
    let file = match streams.open.lock() {
        Ok(open) => open.get(&token).cloned(),
        Err(_) => None,
    };
    let Some(file) = file else { return plain(StatusCode::NOT_FOUND, "no such document stream") };
    let Ok(mut file) = file.lock() else { return plain(StatusCode::INTERNAL_SERVER_ERROR, "stream poisoned") };
    let size = match file.metadata() {
        Ok(m) => m.len(),
        Err(e) => return plain(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|v| parse_range(v, size));
    let (status, start, end) = match range {
        Some(None) => {
            return cors(Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE))
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .body(Vec::new())
                .unwrap_or_default()
        }
        Some(Some(Some((a, b)))) => (StatusCode::PARTIAL_CONTENT, a, b),
        // No range, or one we do not split: the whole file. The viewer always
        // asks for ranges; this is for anything else that fetches the URL.
        Some(Some(None)) | None => (StatusCode::OK, 0, size.saturating_sub(1)),
    };
    let len = if size == 0 { 0 } else { end - start + 1 };
    let mut body = vec![0u8; len as usize];
    if len > 0 {
        if let Err(e) = file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut body)) {
            return plain(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
        }
    }
    let mut builder = cors(Response::builder().status(status))
        .header(header::CONTENT_TYPE, "application/pdf")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, len.to_string());
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"));
    }
    if request.method() == "HEAD" {
        body.clear();
    }
    builder.body(body).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-0", 10), Some(Some((0, 0))));
        assert_eq!(parse_range("bytes=2-", 10), Some(Some((2, 9))));
        assert_eq!(parse_range("bytes=-3", 10), Some(Some((7, 9))));
        assert_eq!(parse_range("bytes=5-100", 10), Some(Some((5, 9))));
        assert_eq!(parse_range("bytes=10-12", 10), None);
        assert_eq!(parse_range("bytes=0-1,4-5", 10), Some(None));
        assert_eq!(parse_range("items=0-1", 10), Some(None));
    }

    #[test]
    fn serves_a_range_of_a_big_file_without_reading_the_rest() {
        let dir = std::env::temp_dir().join(format!("rbdoc-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.pdf");
        // Sparse past 5 GB: no cap, and offsets past 4 GiB work.
        let f = File::create(&path).unwrap();
        f.set_len(5 * 1024 * 1024 * 1024 + 10).unwrap();
        drop(f);
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            f.seek(SeekFrom::End(-4)).unwrap();
            f.write_all(b"%EOF").unwrap();
        }
        let streams = DocStreams::default();
        streams.open.lock().unwrap().insert("t".into(), Arc::new(Mutex::new(File::open(&path).unwrap())));
        let req = Request::builder().uri("rbdoc://localhost/t").header("Range", "bytes=-4").body(Vec::new()).unwrap();
        let res = respond(&streams, &req);
        assert_eq!(res.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(res.body(), b"%EOF");
        let total = 5u64 * 1024 * 1024 * 1024 + 10;
        assert_eq!(
            res.headers().get(header::CONTENT_RANGE).unwrap().to_str().unwrap(),
            format!("bytes {}-{}/{}", total - 4, total - 1, total)
        );
        let small = dir.join("small.pdf");
        std::fs::write(&small, b"abc").unwrap();
        assert_eq!(
            hash_handle(&Mutex::new(File::open(&small).unwrap())).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // A copy with an update appended, from the handle; never over an existing file.
        let handle = Mutex::new(File::open(&small).unwrap());
        let copy = dir.join("sub").join("copy.pdf");
        std::fs::create_dir_all(copy.parent().unwrap()).unwrap();
        copy_with_tail(&handle, &Dest::New(copy.clone()), b"def").unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"abcdef");
        assert!(copy_with_tail(&handle, &Dest::New(copy.clone()), b"").is_err());
        copy_with_tail(&handle, &Dest::Replace(copy.clone()), b"").unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"abc");
        let missing = Request::builder().uri("rbdoc://localhost/nope").body(Vec::new()).unwrap();
        assert_eq!(respond(&streams, &missing).status(), StatusCode::NOT_FOUND);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
