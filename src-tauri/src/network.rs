//! Eden game-server integration: world search, download, and upload.
use std::{fs, io::{Read, Write}};
use tauri::Emitter;

// ── Eden server configuration ────────────────────────────────────────────────

pub(crate) struct EdenServer {
    search_url: &'static str,
    download_base_url: &'static str,
    upload_url: &'static str,
}

pub(crate) const CURRENT_SERVER: EdenServer = EdenServer {
    search_url: "http://app2.edengame.net/list2.php",
    download_base_url: "http://files2.edengame.net",
    upload_url: "http://app2.edengame.net/upload2.php",
};

pub(crate) const LEGACY_SERVER: EdenServer = EdenServer {
    search_url: "http://app.edengame.net/list2.php",
    download_base_url: "http://files.edengame.net",
    upload_url: "http://app.edengame.net/upload2.php",
};

pub(crate) fn get_server(server: &str) -> Result<&'static EdenServer, String> {
    match server {
        "current" => Ok(&CURRENT_SERVER),
        "legacy"  => Ok(&LEGACY_SERVER),
        _         => Err(format!("Unknown server: {server}")),
    }
}

#[derive(serde::Serialize, Clone)]
pub(crate) struct WorldSearchResult {
    id: String,
    name: String,
    timestamp: i64,
}
// ── Network commands ─────────────────────────────────────────────────────────

/// Parse a `list2.php` response body: plain text, alternating `<id>.eden` / `<name>.name` lines,
/// no JSON (Part C6 of the 256z-format plan) — shared by both `search_worlds` (a `?search=`
/// query) and `list_worlds` (a `?start=&sort=` browse page). Scans for a `.eden` line immediately
/// followed by its `.name` line rather than trusting a fixed stride-2 layout — one stray blank
/// line in the response would otherwise desync every subsequent pair.
fn parse_world_list_response(text: &str) -> Vec<WorldSearchResult> {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i + 1 < lines.len() {
        let id_line = lines[i];
        let name_line = lines[i + 1];
        if id_line.ends_with(".eden") && name_line.ends_with(".name") {
            let id = id_line.trim_end_matches(".eden").to_string();
            let name = name_line.trim_end_matches(".name").to_string();
            pairs.push((id, name));
            i += 2;
        } else {
            i += 1;
        }
    }

    pairs
        .into_iter()
        .map(|(id, name)| {
            let timestamp = id.parse::<i64>().unwrap_or(0);
            WorldSearchResult { id, name, timestamp }
        })
        .collect()
}

/// Search the Eden world server. Returns worlds ordered as received from server.
/// Response body is plain text, one filename per line — no file sizes are fetched.
#[tauri::command]
pub(crate) async fn search_worlds(query: String, server: String) -> Result<Vec<WorldSearchResult>, String> {
    let srv = get_server(&server)?;
    let url = format!("{}?search={}", srv.search_url, urlencoding_encode(&query));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let text = client.get(&url).send().await
        .map_err(|e| format!("Failed to query {server} server: {e}"))?
        .text().await
        .map_err(|e| e.to_string())?;

    Ok(parse_world_list_response(&text))
}

/// Browse the Eden world server with no search term — `GET /list2.php?start=<start>&sort=<sort>`,
/// paginated via `start` (the real client sent 0 for its first page when captured; there is no
/// server-advertised page size, so the frontend re-requests with `start = results so far`).
/// `sort`'s exact value semantics beyond "distinguishes an ordering" are unconfirmed — `2` is the
/// value the real desktop client's own World Browser sent (Part C2/C6 of the 256z-format plan).
/// `search_worlds` was VuencEdit's only way to list *any* worlds before this — an empty query was
/// refused frontend-side, unlike the real client's browse mode this mirrors.
#[tauri::command]
pub(crate) async fn list_worlds(start: u32, sort: u32, server: String) -> Result<Vec<WorldSearchResult>, String> {
    let srv = get_server(&server)?;
    let url = format!("{}?start={}&sort={}", srv.search_url, start, sort);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let text = client.get(&url).send().await
        .map_err(|e| format!("Failed to query {server} server: {e}"))?
        .text().await
        .map_err(|e| e.to_string())?;

    Ok(parse_world_list_response(&text))
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateInfo {
    latest_version: String,
    release_url: String,
}

#[derive(serde::Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
}

/// Check GitHub's "latest release" endpoint for the public mirror. GitHub requires a `User-Agent`
/// on API requests (rejects with 403 otherwise) — set to the app name, not a browser UA. Silent-fail
/// is the caller's job (frontend swallows any `Err` here without surfacing it); this command just
/// reports what it found or a plain error string.
#[tauri::command]
pub(crate) async fn check_for_update() -> Result<UpdateInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get("https://api.github.com/repos/hagg3/VuencEdit/releases/latest")
        .header("User-Agent", "VuencEdit-UpdateCheck")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Update check returned {}", response.status()));
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Update check response was malformed: {e}"))?;
    let release: GithubRelease = serde_json::from_str(&body)
        .map_err(|e| format!("Update check response was malformed: {e}"))?;

    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    Ok(UpdateInfo { latest_version, release_url: release.html_url })
}

pub(crate) fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push(char::from_digit((b >> 4) as u32, 16).unwrap().to_ascii_uppercase());
                out.push(char::from_digit((b & 0xf) as u32, 16).unwrap().to_ascii_uppercase());
            }
        }
    }
    out
}

// Server worlds can legitimately be 10 GiB when a large 256z map is densely populated. Keep a
// ceiling above that for forward headroom, but retain a finite bound against hostile responses
// and gzip bombs. The same limit applies to the downloaded response and its decompressed form.
const MAX_DOWNLOADED_WORLD_BYTES: u64 = 12 * 1024 * 1024 * 1024;
const MAX_DOWNLOADED_WORLD_GIB: u64 = MAX_DOWNLOADED_WORLD_BYTES / (1024 * 1024 * 1024);

/// Copy a stream while limiting output without writing a byte beyond `max_bytes`.
/// Returns `Ok(false)` when there is more input after the permitted output.
fn copy_capped<R: Read, W: Write>(reader: &mut R, writer: &mut W, max_bytes: u64) -> std::io::Result<bool> {
    let mut buf = [0u8; 64 * 1024];
    let mut written = 0u64;
    loop {
        let remaining_plus_probe = max_bytes.saturating_sub(written).saturating_add(1);
        let read_len = remaining_plus_probe.min(buf.len() as u64) as usize;
        let read = reader.read(&mut buf[..read_len])?;
        if read == 0 { return Ok(true); }
        let remaining = max_bytes.saturating_sub(written);
        if read as u64 > remaining {
            if remaining > 0 { writer.write_all(&buf[..remaining as usize])?; }
            return Ok(false);
        }
        writer.write_all(&buf[..read])?;
        written += read as u64;
    }
}

fn size_limit_error(stage: &str) -> String {
    format!("Downloaded world {stage} exceeds the {MAX_DOWNLOADED_WORLD_GIB} GiB safety limit")
}

fn write_error(stage: &str, error: std::io::Error) -> String {
    format!("Failed to {stage}: {error}. Check available disk space and file permissions")
}

/// Download a world from the Eden server, streaming to disk with progress events.
///
/// The compressed response body is streamed straight into a temp file as it arrives (never
/// buffered whole in RAM), then decompressed file→file through a size-capped reader so a
/// malicious/misbehaving server can't OOM the process either during download or decompression.
#[tauri::command]
pub(crate) async fn download_world(
    app: tauri::AppHandle,
    id: String,
    server: String,
    dest_path: String,
) -> Result<(), String> {
    let srv = get_server(&server)?;
    let url = format!("{}/{}.eden", srv.download_base_url, id);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let mut response = client.get(&url).send().await
        .map_err(|e| format!("Download failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("Server returned {}", response.status()));
    }

    let total = response.content_length();
    if total.is_some_and(|bytes| bytes > MAX_DOWNLOADED_WORLD_BYTES) {
        return Err(size_limit_error("response"));
    }
    let mut downloaded: u64 = 0;
    let raw_tmp_path = format!("{}.download.tmp", dest_path);
    let mut raw_file = fs::File::create(&raw_tmp_path)
        .map_err(|e| write_error("create temporary download file", e))?;
    // First bytes only, to sniff gzip magic after the stream completes.
    let mut head: Vec<u8> = Vec::new();

    while let Some(chunk) = match response.chunk().await {
        Ok(chunk) => chunk,
        Err(e) => {
            drop(raw_file);
            let _ = fs::remove_file(&raw_tmp_path);
            return Err(format!("Download failed: {e}"));
        }
    } {
        downloaded = downloaded.saturating_add(chunk.len() as u64);
        if downloaded > MAX_DOWNLOADED_WORLD_BYTES {
            drop(raw_file);
            let _ = fs::remove_file(&raw_tmp_path);
            return Err(size_limit_error("response"));
        }
        if head.len() < 2 { head.extend(chunk.iter().take(2 - head.len())); }
        if let Err(e) = raw_file.write_all(&chunk) {
            drop(raw_file);
            let _ = fs::remove_file(&raw_tmp_path);
            return Err(write_error("write temporary download file", e));
        }
        let _ = app.emit("download-progress", serde_json::json!({
            "downloaded": downloaded,
            "total": total
        }));
    }
    drop(raw_file);

    let tmp_path = format!("{}.tmp", dest_path);
    let cleanup = |paths: &[&str]| { for p in paths { let _ = fs::remove_file(p); } };

    // Server delivers worlds gzip-compressed; decompress to raw .eden before saving
    // so load_world can mmap it directly (it only handles zip-PK or raw).
    if head.starts_with(&[0x1f, 0x8b]) {
        use flate2::read::GzDecoder;
        let src = fs::File::open(&raw_tmp_path).map_err(|e| format!("Failed to read temporary download file: {e}"))?;
        let mut dec = GzDecoder::new(std::io::BufReader::new(src));
        let mut out = fs::File::create(&tmp_path).map_err(|e| write_error("create decompressed world file", e))?;
        let copy_result = copy_capped(&mut dec, &mut out, MAX_DOWNLOADED_WORLD_BYTES);
        drop(out);
        match copy_result {
            Ok(true) => cleanup(&[&raw_tmp_path]),
            Ok(false) => {
                cleanup(&[&raw_tmp_path, &tmp_path]);
                return Err(size_limit_error("after decompression"));
            }
            Err(e) => {
                cleanup(&[&raw_tmp_path, &tmp_path]);
                return Err(write_error("decompress downloaded world", e));
            }
        }
    } else {
        fs::rename(&raw_tmp_path, &tmp_path).map_err(|e| format!("Rename failed: {e}"))?;
    }

    fs::rename(&tmp_path, &dest_path).map_err(|e| format!("Rename failed: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{copy_capped, parse_world_list_response};
    use std::io::Cursor;

    #[test]
    fn parse_world_list_response_pairs_eden_and_name_lines() {
        let text = "1690000001.eden\nFirst World.name\n1690000002.eden\nSecond World.name\n";
        let results = parse_world_list_response(text);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].id, "1690000001");
        assert_eq!(results[0].name, "First World");
        assert_eq!(results[0].timestamp, 1690000001);
        assert_eq!(results[1].id, "1690000002");
        assert_eq!(results[1].name, "Second World");
    }

    #[test]
    fn parse_world_list_response_resyncs_past_a_stray_blank_line() {
        let text = "1690000001.eden\n\nFirst World.name\n1690000002.eden\nSecond World.name\n";
        let results = parse_world_list_response(text);
        // The blank line desyncs the first pair (id line no longer immediately precedes its name
        // line), but the scan must still find the second, well-formed pair.
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "1690000002");
    }

    #[test]
    fn parse_world_list_response_empty_body_yields_no_results() {
        assert!(parse_world_list_response("").is_empty());
    }

    #[test]
    fn copy_capped_accepts_input_at_the_limit() {
        let mut input = Cursor::new(vec![1, 2, 3, 4]);
        let mut output = Vec::new();
        assert!(copy_capped(&mut input, &mut output, 4).unwrap());
        assert_eq!(output, vec![1, 2, 3, 4]);
    }

    #[test]
    fn copy_capped_rejects_input_past_the_limit_without_writing_the_extra_byte() {
        let mut input = Cursor::new(vec![1, 2, 3, 4, 5]);
        let mut output = Vec::new();
        assert!(!copy_capped(&mut input, &mut output, 4).unwrap());
        assert_eq!(output, vec![1, 2, 3, 4]);
    }
}

/// Upload a world file + PNG preview to the Eden server. Generates a client-side UUID (matching
/// the format the iOS client's `UIDevice.identifierForVendor` produces) and POSTs the multipart
/// form to `?uuid=<uuid>` directly — no GET round-trip first. Confirmed against the real desktop
/// client's own traffic 2026-08-18 (see DOCUMENTATION/10-features.md): it also generates its own
/// UUID client-side rather than fetching one, and sends exactly two parts, `uploaded`/`uploaded2`
/// (field *names*, not filenames), no third `submit` field.
#[tauri::command]
pub(crate) async fn upload_world(
    app: tauri::AppHandle,
    world_path: String,
    image_path: String,
    server: String,
) -> Result<String, String> {
    let srv = get_server(&server)?;
    let raw_world = fs::read(&world_path).map_err(|e| format!("Cannot read world: {e}"))?;
    let image_bytes = fs::read(&image_path).map_err(|e| format!("Cannot read image: {e}"))?;
    const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
    if image_bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "Preview image is {:.1} MB — maximum allowed size is 2 MB",
            image_bytes.len() as f64 / 1_048_576.0
        ));
    }

    // Server stores and delivers worlds as gzip; upload in gzip format to match.
    // If already gzip: upload as-is. If zip (PK): decompress to raw first, then gzip.
    let world_bytes: Vec<u8> = if raw_world.starts_with(&[0x1f, 0x8b]) {
        raw_world
    } else {
        use flate2::{write::GzEncoder, Compression};
        use std::io::Write;
        let raw = if raw_world.starts_with(&[0x50, 0x4B, 0x03, 0x04]) {
            use zip::ZipArchive;
            let cursor = std::io::Cursor::new(&raw_world);
            let mut archive = ZipArchive::new(cursor).map_err(|e| format!("Invalid zip: {e}"))?;
            let mut entry = archive.by_index(0).map_err(|e| format!("Zip entry: {e}"))?;
            let mut out = Vec::new();
            std::io::copy(&mut entry, &mut out).map_err(|e| format!("Decompress zip: {e}"))?;
            out
        } else {
            raw_world
        };
        let mut enc = GzEncoder::new(Vec::new(), Compression::best());
        enc.write_all(&raw).map_err(|e| format!("Gzip write: {e}"))?;
        enc.finish().map_err(|e| format!("Gzip finish: {e}"))?
    };

    let total = (world_bytes.len() + image_bytes.len()) as u64;

    let _ = app.emit("upload-progress", serde_json::json!({ "bytes_sent": 0u64, "total": total }));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    // Generate a UUID-format identifier matching what the iOS Eden client sends
    // (UIDevice.identifierForVendor — format XXXXXXXX-XXXX-4XXX-8XXX-XXXXXXXXXXXX).
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let uuid = format!("{:08X}-{:04X}-4{:03X}-{:04X}-{:012X}",
        ts as u32,
        (ts >> 32) as u16,
        (ts >> 16) as u16 & 0xFFF,
        0x8000u16 | ((ts >> 48) as u16 & 0x3FFF),
        ts & 0x0000_FFFF_FFFF_FFFF_u64);
    let post_url = format!("{}?uuid={}", srv.upload_url, uuid);

    // Field *names* must be "uploaded"/"uploaded2" — confirmed 2026-08-18 by capturing the real
    // desktop client's own upload traffic (see DOCUMENTATION/10-features.md). The PHP endpoint keys
    // off the form field name (`$_FILES['uploaded']`), not the filename — the previous
    // "file.bin"/"image.bin" field names meant every VuencEdit-originated upload was silently going
    // to an empty $_FILES slot server-side despite the 200 OK response, since the server's success
    // reply doesn't depend on the file actually being found under the field it expected. Filenames
    // are literally "file.bin"/"image.bin" (not the source path's own name) to match the observed
    // request byte-for-byte; the server does not appear to use them for anything.
    let form = reqwest::multipart::Form::new()
        .part("uploaded", reqwest::multipart::Part::bytes(world_bytes)
            .file_name("file.bin")
            .mime_str("application/octet-stream").unwrap())
        .part("uploaded2", reqwest::multipart::Part::bytes(image_bytes)
            .file_name("image.bin")
            .mime_str("image/png").unwrap());

    let response = client.post(&post_url).multipart(form).send().await
        .map_err(|e| format!("Upload failed: {e}"))?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    let _ = app.emit("upload-progress", serde_json::json!({ "bytes_sent": total, "total": total }));

    if !status.is_success() {
        return Err(format!("Server returned {status}: {body}"));
    }

    Ok(body)
}
