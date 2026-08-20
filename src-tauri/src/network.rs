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

/// Fetch the server's live featured/popular world list — `GET {download_base_url}/popularlist.txt`,
/// same alternating `<id>.eden` / `<name>.name` plain-text format as `list2.php`, served from the
/// download host rather than the search host (confirmed by the user against the live URLs).
#[tauri::command]
pub(crate) async fn fetch_featured_worlds(server: String) -> Result<Vec<WorldSearchResult>, String> {
    let srv = get_server(&server)?;
    let url = format!("{}/popularlist.txt", srv.download_base_url);
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
pub(crate) struct LegacyFeaturedList {
    /// Bare filename, e.g. `search--leaderboard-20180205.txt` — the only value round-tripped
    /// back into `load_legacy_featured_list`; never build a path from user input elsewhere.
    filename: String,
    /// `YYYY-MM-DD` parsed from the filename, for display; falls back to the filename itself if
    /// the archive ever gains a differently-named entry.
    date: String,
}

/// `search--leaderboard-<8 digits>.txt` — the only filename shape accepted, both when listing the
/// bundled archive and when validating a filename handed back from the frontend for loading.
fn parse_leaderboard_filename(filename: &str) -> Option<String> {
    let stem = filename.strip_prefix("search--leaderboard-")?.strip_suffix(".txt")?;
    if stem.len() != 8 || !stem.bytes().all(|b| b.is_ascii_digit()) { return None; }
    Some(format!("{}-{}-{}", &stem[0..4], &stem[4..6], &stem[6..8]))
}

fn leaderboards_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path().resolve("eden-leaderboards", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve leaderboard archive directory: {e}"))
}

/// List the bundled historic featured-world snapshots (`eden-leaderboards/*.txt`), newest first.
#[tauri::command]
pub(crate) fn list_legacy_featured_lists(app: tauri::AppHandle) -> Result<Vec<LegacyFeaturedList>, String> {
    let dir = leaderboards_dir(&app)?;
    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("Failed to read leaderboard archive at {}: {e}", dir.display()))?;

    let mut out: Vec<LegacyFeaturedList> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(date) = parse_leaderboard_filename(&name) {
            out.push(LegacyFeaturedList { filename: name, date });
        }
    }
    out.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(out)
}

/// Load one bundled historic featured-world snapshot by filename. `filename` is validated against
/// the same fixed shape `list_legacy_featured_lists` produces, so it can never escape the archive
/// directory regardless of what the frontend sends.
#[tauri::command]
pub(crate) fn load_legacy_featured_list(app: tauri::AppHandle, filename: String) -> Result<Vec<WorldSearchResult>, String> {
    if parse_leaderboard_filename(&filename).is_none() {
        return Err(format!("Invalid leaderboard archive filename: {filename}"));
    }
    let path = leaderboards_dir(&app)?.join(&filename);
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
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
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(60))
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
    use super::{copy_capped, parse_leaderboard_filename, parse_world_list_response};
    use std::io::Cursor;

    #[test]
    fn parse_leaderboard_filename_accepts_the_bundled_shape() {
        assert_eq!(
            parse_leaderboard_filename("search--leaderboard-20180205.txt"),
            Some("2018-02-05".to_string())
        );
    }

    #[test]
    fn parse_leaderboard_filename_rejects_anything_else() {
        assert_eq!(parse_leaderboard_filename("search--leaderboard-2018020.txt"), None);
        assert_eq!(parse_leaderboard_filename("search--leaderboard-2018020x.txt"), None);
        assert_eq!(parse_leaderboard_filename("../../etc/passwd"), None);
        assert_eq!(parse_leaderboard_filename("search--leaderboard-20180205.txt.eden"), None);
        assert_eq!(parse_leaderboard_filename(""), None);
    }

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
/// Progress events are emitted at most once per this many bytes, so a multi-GB upload doesn't
/// flood the IPC channel with tens of thousands of events (the bar can't show more than this).
const UPLOAD_PROGRESS_STEP: u64 = 1024 * 1024;

/// A temp file that deletes itself when dropped — used for the gzip staging file below, so an
/// aborted or failed upload doesn't leak a world-sized file into `$TMPDIR`.
struct TempFile(std::path::PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
}

/// Gzip `src` into a fresh temp file, streaming through a fixed buffer (audit C4).
///
/// The server stores and delivers worlds as gzip. This used to be `fs::read` → (unzip into a
/// second `Vec`) → `GzEncoder::new(Vec::new(), Compression::best())` → `Part::bytes`, i.e. two to
/// three whole copies of the world resident before the first byte went out — 4–6 GB for a 2 GB
/// world. Compressing to a file instead costs a 64 KB buffer, and it is also what makes a *real*
/// `Content-Length` possible: a gzip stream's length isn't known until it's finished, and without
/// one the upload would have to fall back to chunked transfer encoding against a PHP endpoint that
/// has never been observed accepting it.
///
/// Returns `None` when the source is already gzip — that file is streamed directly, no temp.
/// `Compression::new(6)` rather than `best()`: about 1 % larger on voxel data and several times
/// faster (audit C4).
fn gzip_world_to_temp(src: &std::path::Path) -> Result<Option<(TempFile, u64)>, String> {
    use flate2::{write::GzEncoder, Compression};

    let mut probe = [0u8; 4];
    {
        let mut f = fs::File::open(src).map_err(|e| format!("Cannot read world: {e}"))?;
        let mut read = 0usize;
        while read < 4 {
            match f.read(&mut probe[read..]) {
                Ok(0) => break,
                Ok(n) => read += n,
                Err(e) => return Err(format!("Cannot read world: {e}")),
            }
        }
        if probe[..2] == [0x1f, 0x8b] { return Ok(None); }
    }

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp = TempFile(std::env::temp_dir().join(format!("vuencedit_upload_{ts}.gz")));
    let out = fs::File::create(&temp.0).map_err(|e| format!("Cannot stage upload: {e}"))?;
    let mut enc = GzEncoder::new(std::io::BufWriter::new(out), Compression::new(6));

    if probe == [0x50, 0x4B, 0x03, 0x04] {
        // Zip container: stream the first entry straight into the encoder.
        let f = fs::File::open(src).map_err(|e| format!("Cannot read world: {e}"))?;
        let mut archive = zip::ZipArchive::new(std::io::BufReader::new(f))
            .map_err(|e| format!("Invalid zip: {e}"))?;
        let mut entry = archive.by_index(0).map_err(|e| format!("Zip entry: {e}"))?;
        std::io::copy(&mut entry, &mut enc).map_err(|e| format!("Decompress zip: {e}"))?;
    } else {
        let f = fs::File::open(src).map_err(|e| format!("Cannot read world: {e}"))?;
        let mut r = std::io::BufReader::with_capacity(256 * 1024, f);
        std::io::copy(&mut r, &mut enc).map_err(|e| format!("Gzip write: {e}"))?;
    }
    let mut w = enc.finish().map_err(|e| format!("Gzip finish: {e}"))?;
    w.flush().map_err(|e| format!("Gzip flush: {e}"))?;
    drop(w);

    let len = fs::metadata(&temp.0).map_err(|e| format!("Cannot stat upload: {e}"))?.len();
    Ok(Some((temp, len)))
}

/// Wrap `path` in a reqwest body that streams it from disk and emits truthful `upload-progress`
/// events as bytes leave (audit C4). Progress used to be a lie: exactly two events fired, 0 % at
/// the start and 100 % at the end, so a ten-minute upload showed a bar pinned at zero.
async fn upload_body_with_progress(
    app: tauri::AppHandle,
    path: std::path::PathBuf,
    total: u64,
) -> Result<reqwest::Body, String> {
    use futures_util::StreamExt;

    let file = tokio::fs::File::open(&path).await
        .map_err(|e| format!("Cannot read staged upload: {e}"))?;
    let reader = tokio_util::io::ReaderStream::with_capacity(file, 256 * 1024);
    let mut sent: u64 = 0;
    let mut last_emit: u64 = 0;
    let stream = reader.map(move |chunk| {
        if let Ok(b) = &chunk {
            sent += b.len() as u64;
            if sent - last_emit >= UPLOAD_PROGRESS_STEP {
                last_emit = sent;
                let _ = app.emit("upload-progress",
                    serde_json::json!({ "bytes_sent": sent.min(total), "total": total }));
            }
        }
        chunk
    });
    Ok(reqwest::Body::wrap_stream(stream))
}

#[tauri::command]
pub(crate) async fn upload_world(
    app: tauri::AppHandle,
    world_path: String,
    image_path: String,
    server: String,
) -> Result<String, String> {
    let srv = get_server(&server)?;
    let image_bytes = fs::read(&image_path).map_err(|e| format!("Cannot read image: {e}"))?;
    const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
    if image_bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "Preview image is {:.1} MB — maximum allowed size is 2 MB",
            image_bytes.len() as f64 / 1_048_576.0
        ));
    }

    // Compress off the async runtime — this is minutes of CPU on a large world.
    let src = std::path::PathBuf::from(&world_path);
    let staged = tokio::task::spawn_blocking(move || gzip_world_to_temp(&src))
        .await
        .map_err(|e| format!("Compression task failed: {e}"))??;

    // `_keep` holds the temp alive (and deletes it) for the rest of this function.
    let (body_path, world_len, _keep) = match staged {
        Some((temp, len)) => (temp.0.clone(), len, Some(temp)),
        None => {
            // Already gzip — stream the user's file itself, no staging copy.
            let len = fs::metadata(&world_path)
                .map_err(|e| format!("Cannot read world: {e}"))?.len();
            (std::path::PathBuf::from(&world_path), len, None)
        }
    };

    let total = world_len + image_bytes.len() as u64;
    let _ = app.emit("upload-progress", serde_json::json!({ "bytes_sent": 0u64, "total": total }));

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(60))
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
    //
    // ⚠️ `stream_with_length` (not `stream`) — with a length the part is sent with a real
    // `Content-Length` exactly as the byte-buffer version was; without one reqwest switches the
    // whole request to chunked transfer encoding, which this endpoint has never been observed
    // accepting.
    let world_body = upload_body_with_progress(app.clone(), body_path, total).await?;
    let form = reqwest::multipart::Form::new()
        .part("uploaded", reqwest::multipart::Part::stream_with_length(world_body, world_len)
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
