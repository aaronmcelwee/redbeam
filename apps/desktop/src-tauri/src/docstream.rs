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
        let missing = Request::builder().uri("rbdoc://localhost/nope").body(Vec::new()).unwrap();
        assert_eq!(respond(&streams, &missing).status(), StatusCode::NOT_FOUND);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
