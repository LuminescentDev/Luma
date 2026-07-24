use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use base64::Engine;
use fs2::FileExt;
use reqwest::header::{ETAG, IF_MATCH, IF_NONE_MATCH};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::errors::{LumaError, Result};

use super::MAX_BLOB_BYTES;

const SYNC_FILE_NAME: &str = "luma-sync.bin";
const LOCK_FILE_NAME: &str = ".luma-sync.lock";
const GIST_FILE_NAME: &str = "luma-sync.bin.b64";
const STALE_LOCK_AGE: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone)]
pub struct RemoteBlob {
    pub bytes: Vec<u8>,
    pub version: String,
}

#[derive(Debug, Clone)]
pub struct UploadResult {
    pub version: String,
    pub remote_id: Option<String>,
}

#[async_trait]
pub trait SyncProvider: Send + Sync {
    async fn download(&self) -> Result<Option<RemoteBlob>>;
    async fn upload(
        &self,
        blob: &[u8],
        expected_remote_version: Option<&str>,
    ) -> Result<UploadResult>;
}

pub struct LocalFolderProvider {
    directory: PathBuf,
}

impl LocalFolderProvider {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    fn blob_path(&self) -> PathBuf {
        self.directory.join(SYNC_FILE_NAME)
    }

    fn current(&self) -> Result<Option<RemoteBlob>> {
        let path = self.blob_path();
        match fs::metadata(&path) {
            Ok(metadata) => {
                if metadata.len() > MAX_BLOB_BYTES as u64 {
                    return Err(LumaError::SyncUnavailable(
                        "remote sync blob exceeds the size limit".into(),
                    ));
                }
                let bytes = fs::read(path).map_err(sync_io)?;
                Ok(Some(RemoteBlob {
                    version: content_version(&bytes),
                    bytes,
                }))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(sync_io(error)),
        }
    }
}

#[async_trait]
impl SyncProvider for LocalFolderProvider {
    async fn download(&self) -> Result<Option<RemoteBlob>> {
        if !self.directory.is_dir() {
            return Err(LumaError::SyncUnavailable(
                "local sync folder does not exist".into(),
            ));
        }
        self.current()
    }

    async fn upload(
        &self,
        blob: &[u8],
        expected_remote_version: Option<&str>,
    ) -> Result<UploadResult> {
        if blob.len() > MAX_BLOB_BYTES {
            return Err(LumaError::InvalidInput(
                "encrypted sync blob exceeds the size limit".into(),
            ));
        }
        if !self.directory.is_dir() {
            return Err(LumaError::SyncUnavailable(
                "local sync folder does not exist".into(),
            ));
        }

        let _guard = LocalSyncLock::acquire(&self.directory)?;
        let current = self.current()?;
        verify_expected_version(current.as_ref(), expected_remote_version)?;

        atomic_write(&self.blob_path(), blob)?;
        Ok(UploadResult {
            version: content_version(blob),
            remote_id: None,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
struct LockOwner {
    process_id: u32,
    created_at_unix_seconds: u64,
}

struct LocalSyncLock {
    file: Option<File>,
    path: PathBuf,
}

impl LocalSyncLock {
    fn acquire(directory: &Path) -> Result<Self> {
        let path = directory.join(LOCK_FILE_NAME);
        let (mut file, created) = match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => (file, true),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let file = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&path)
                    .map_err(sync_io)?;
                (file, false)
            }
            Err(error) => return Err(sync_io(error)),
        };
        file.try_lock_exclusive().map_err(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                LumaError::SyncConflict("another sync is writing the local folder".into())
            } else {
                sync_io(error)
            }
        })?;

        if !created {
            let mut contents = String::new();
            file.read_to_string(&mut contents).map_err(sync_io)?;
            let owner = serde_json::from_str::<LockOwner>(&contents).ok();
            let stale = owner.as_ref().is_some_and(lock_owner_is_stale)
                || (owner.is_none() && lock_file_is_old(&file));
            if !stale {
                let _ = FileExt::unlock(&file);
                return Err(LumaError::SyncConflict(
                    "another sync is writing the local folder".into(),
                ));
            }
        }

        let owner = LockOwner {
            process_id: std::process::id(),
            created_at_unix_seconds: unix_timestamp(),
        };
        file.set_len(0).map_err(sync_io)?;
        file.seek(SeekFrom::Start(0)).map_err(sync_io)?;
        serde_json::to_writer(&mut file, &owner).map_err(|error| {
            LumaError::SyncUnavailable(format!("could not record local sync lock owner: {error}"))
        })?;
        file.flush().map_err(sync_io)?;
        file.sync_all().map_err(sync_io)?;
        Ok(Self {
            file: Some(file),
            path,
        })
    }
}

impl Drop for LocalSyncLock {
    fn drop(&mut self) {
        if let Some(file) = self.file.take() {
            let _ = FileExt::unlock(&file);
            drop(file);
        }
        let _ = fs::remove_file(&self.path);
    }
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn lock_owner_is_stale(owner: &LockOwner) -> bool {
    unix_timestamp().saturating_sub(owner.created_at_unix_seconds) > STALE_LOCK_AGE.as_secs()
        || !process_is_alive(owner.process_id)
}

fn lock_file_is_old(file: &File) -> bool {
    file.metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > STALE_LOCK_AGE)
}

#[cfg(unix)]
fn process_is_alive(process_id: u32) -> bool {
    if process_id == 0 || process_id > i32::MAX as u32 {
        return false;
    }
    // SAFETY: kill(pid, 0) performs only a liveness/permission check and does
    // not send a signal. The PID is range-checked above.
    let result = unsafe { libc::kill(process_id as i32, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_is_alive(process_id: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    if process_id == 0 {
        return false;
    }
    // SAFETY: the handle is requested with synchronization-only access and is
    // closed on every successful OpenProcess path.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, process_id) };
    if handle.is_null() {
        return false;
    }
    // SAFETY: handle is a valid process handle and the zero timeout is
    // non-blocking. CloseHandle releases it immediately afterwards.
    let status = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    status == WAIT_TIMEOUT
}

#[cfg(not(any(unix, windows)))]
fn process_is_alive(process_id: u32) -> bool {
    process_id == std::process::id()
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    atomic_write_before_replace(path, bytes, || Ok(()))
}

fn atomic_write_before_replace(
    path: &Path,
    bytes: &[u8],
    before_replace: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(SYNC_FILE_NAME);
    let temp_path = path.with_file_name(format!(
        ".{file_name}.tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let guard = TempFileGuard(temp_path.clone());
    let mut temp = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)
        .map_err(sync_io)?;
    temp.write_all(bytes).map_err(sync_io)?;
    temp.flush().map_err(sync_io)?;
    temp.sync_all().map_err(sync_io)?;
    drop(temp);
    before_replace()?;
    atomic_replace(&temp_path, path)?;
    std::mem::forget(guard);
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> Result<()> {
    fs::rename(source, destination).map_err(sync_io)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both paths are NUL-terminated UTF-16 buffers that remain alive
    // for the duration of the call.
    let replaced = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(sync_io(std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

pub struct WebDavProvider {
    client: reqwest::Client,
    url: String,
    username: String,
    password: String,
}

pub struct LumaCloudProvider {
    client: reqwest::Client,
    api_url: String,
    access_token: String,
}

impl LumaCloudProvider {
    pub fn new(api_url: String, access_token: String) -> Result<Self> {
        validate_cloud_api_url(&api_url)?;
        Ok(Self {
            client: http_client()?,
            api_url: api_url.trim_end_matches('/').to_string(),
            access_token,
        })
    }

    fn request(&self, method: reqwest::Method) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{}/v1/sync", self.api_url))
            .bearer_auth(&self.access_token)
    }
}

#[async_trait]
impl SyncProvider for LumaCloudProvider {
    async fn download(&self) -> Result<Option<RemoteBlob>> {
        let response = self
            .request(reqwest::Method::GET)
            .send()
            .await
            .map_err(network_error)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        check_cloud_status(&response)?;
        ensure_response_size(&response)?;
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| LumaError::SyncUnavailable("Luma Cloud response has no version".into()))?
            .to_string();
        let bytes = response.bytes().await.map_err(network_error)?.to_vec();
        if bytes.len() > MAX_BLOB_BYTES {
            return Err(LumaError::SyncUnavailable(
                "remote sync blob exceeds the size limit".into(),
            ));
        }
        Ok(Some(RemoteBlob {
            bytes,
            version: format!("etag:{etag}"),
        }))
    }

    async fn upload(
        &self,
        blob: &[u8],
        expected_remote_version: Option<&str>,
    ) -> Result<UploadResult> {
        if blob.len() > MAX_BLOB_BYTES {
            return Err(LumaError::InvalidInput(
                "sync blob exceeds the size limit".into(),
            ));
        }
        let mut request = self
            .request(reqwest::Method::PUT)
            .header(reqwest::header::CONTENT_TYPE, "application/vnd.luma.sync")
            .body(blob.to_vec());
        request = match expected_remote_version {
            Some(version) => request.header(
                IF_MATCH,
                version.strip_prefix("etag:").ok_or_else(|| {
                    LumaError::SyncUnavailable("stored Luma Cloud version is invalid".into())
                })?,
            ),
            None => request.header(IF_NONE_MATCH, "*"),
        };
        let response = request.send().await.map_err(network_error)?;
        check_cloud_status(&response)?;
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| {
                LumaError::SyncUnavailable("Luma Cloud response has no version".into())
            })?;
        Ok(UploadResult {
            version: format!("etag:{etag}"),
            remote_id: None,
        })
    }
}

impl WebDavProvider {
    pub fn new(url: String, username: String, password: String) -> Result<Self> {
        validate_https_url(&url)?;
        Ok(Self {
            client: http_client()?,
            url,
            username,
            password,
        })
    }

    async fn get(&self) -> Result<Option<RemoteBlob>> {
        let response = self
            .client
            .get(&self.url)
            .basic_auth(&self.username, Some(&self.password))
            .send()
            .await
            .map_err(network_error)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        check_auth_or_status(&response)?;
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        ensure_response_size(&response)?;
        let bytes = response.bytes().await.map_err(network_error)?.to_vec();
        if bytes.len() > MAX_BLOB_BYTES {
            return Err(LumaError::SyncUnavailable(
                "remote sync blob exceeds the size limit".into(),
            ));
        }
        Ok(Some(RemoteBlob {
            version: etag
                .map(|value| format!("etag:{value}"))
                .unwrap_or_else(|| content_version(&bytes)),
            bytes,
        }))
    }
}

#[async_trait]
impl SyncProvider for WebDavProvider {
    async fn download(&self) -> Result<Option<RemoteBlob>> {
        self.get().await
    }

    async fn upload(
        &self,
        blob: &[u8],
        expected_remote_version: Option<&str>,
    ) -> Result<UploadResult> {
        let current = self.get().await?;
        verify_expected_version(current.as_ref(), expected_remote_version)?;

        let mut request = self
            .client
            .put(&self.url)
            .basic_auth(&self.username, Some(&self.password))
            .body(blob.to_vec());
        if let Some(etag) = expected_remote_version.and_then(|value| value.strip_prefix("etag:")) {
            request = request.header(IF_MATCH, etag);
        } else if expected_remote_version.is_none() {
            request = request.header(IF_NONE_MATCH, "*");
        }
        let response = request.send().await.map_err(network_error)?;
        if response.status() == reqwest::StatusCode::PRECONDITION_FAILED {
            return Err(LumaError::SyncConflict(
                "the WebDAV sync file changed during upload".into(),
            ));
        }
        check_auth_or_status(&response)?;
        let version = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(|value| format!("etag:{value}"))
            .unwrap_or_else(|| content_version(blob));
        Ok(UploadResult {
            version,
            remote_id: None,
        })
    }
}

pub struct GitHubGistProvider {
    client: reqwest::Client,
    token: String,
    gist_id: Option<String>,
}

impl GitHubGistProvider {
    pub fn new(token: String, gist_id: Option<String>) -> Result<Self> {
        Ok(Self {
            client: http_client()?,
            token,
            gist_id,
        })
    }

    fn request(&self, method: reqwest::Method, url: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, url)
            .bearer_auth(&self.token)
            .header(reqwest::header::USER_AGENT, "Luma")
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
    }

    async fn get(&self) -> Result<Option<RemoteBlob>> {
        let Some(gist_id) = &self.gist_id else {
            return Ok(None);
        };
        let url = format!("https://api.github.com/gists/{gist_id}");
        let response = self
            .request(reqwest::Method::GET, &url)
            .send()
            .await
            .map_err(network_error)?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(LumaError::SyncUnavailable(
                "the configured GitHub gist does not exist".into(),
            ));
        }
        check_auth_or_status(&response)?;
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        ensure_response_size_with_limit(&response, MAX_BLOB_BYTES * 2)?;
        let response_bytes = response.bytes().await.map_err(network_error)?;
        if response_bytes.len() > MAX_BLOB_BYTES * 2 {
            return Err(LumaError::SyncUnavailable(
                "GitHub gist response exceeds the size limit".into(),
            ));
        }
        let gist: GistResponse = serde_json::from_slice(&response_bytes).map_err(|_| {
            LumaError::SyncUnavailable("GitHub returned an invalid gist response".into())
        })?;
        let file = gist.files.get(GIST_FILE_NAME).ok_or_else(|| {
            LumaError::SyncUnavailable("the configured gist has no Luma sync file".into())
        })?;
        let encoded = if file.truncated.unwrap_or(false) {
            let raw_url = file.raw_url.as_deref().ok_or_else(|| {
                LumaError::SyncUnavailable("the GitHub gist sync file is truncated".into())
            })?;
            let raw = self
                .request(reqwest::Method::GET, raw_url)
                .send()
                .await
                .map_err(network_error)?;
            check_auth_or_status(&raw)?;
            ensure_response_size_with_limit(&raw, MAX_BLOB_BYTES * 2)?;
            let raw_bytes = raw.bytes().await.map_err(network_error)?;
            if raw_bytes.len() > MAX_BLOB_BYTES * 2 {
                return Err(LumaError::SyncUnavailable(
                    "GitHub gist sync file exceeds the size limit".into(),
                ));
            }
            String::from_utf8(raw_bytes.to_vec()).map_err(|_| {
                LumaError::SyncUnavailable("the GitHub gist contains invalid sync data".into())
            })?
        } else {
            file.content.clone().ok_or_else(|| {
                LumaError::SyncUnavailable("the GitHub gist sync file is empty".into())
            })?
        };
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|_| {
                LumaError::SyncUnavailable("the GitHub gist contains invalid sync data".into())
            })?;
        if bytes.len() > MAX_BLOB_BYTES {
            return Err(LumaError::SyncUnavailable(
                "remote sync blob exceeds the size limit".into(),
            ));
        }
        let version = etag
            .map(|value| format!("etag:{value}"))
            .or_else(|| gist.updated_at.map(|value| format!("updated-at:{value}")))
            .unwrap_or_else(|| content_version(&bytes));
        Ok(Some(RemoteBlob { bytes, version }))
    }
}

#[async_trait]
impl SyncProvider for GitHubGistProvider {
    async fn download(&self) -> Result<Option<RemoteBlob>> {
        self.get().await
    }

    async fn upload(
        &self,
        blob: &[u8],
        expected_remote_version: Option<&str>,
    ) -> Result<UploadResult> {
        let current = self.get().await?;
        verify_expected_version(current.as_ref(), expected_remote_version)?;

        let encoded = base64::engine::general_purpose::STANDARD.encode(blob);
        let body = gist_upload_body(encoded);
        let (method, url) = match &self.gist_id {
            Some(gist_id) => (
                reqwest::Method::PATCH,
                format!("https://api.github.com/gists/{gist_id}"),
            ),
            None => (reqwest::Method::POST, "https://api.github.com/gists".into()),
        };
        let mut request = self.request(method, &url).json(&body);
        if let Some(etag) = expected_remote_version.and_then(|value| value.strip_prefix("etag:")) {
            request = request.header(IF_MATCH, etag);
        }
        let response = request.send().await.map_err(network_error)?;
        if response.status() == reqwest::StatusCode::PRECONDITION_FAILED {
            return Err(LumaError::SyncConflict(
                "the GitHub gist changed during upload".into(),
            ));
        }
        check_auth_or_status(&response)?;
        let etag = response
            .headers()
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let gist: GistResponse = response.json().await.map_err(|_| {
            LumaError::SyncUnavailable("GitHub returned an invalid gist response".into())
        })?;
        let version = etag
            .map(|value| format!("etag:{value}"))
            .or_else(|| gist.updated_at.map(|value| format!("updated-at:{value}")))
            .unwrap_or_else(|| content_version(blob));
        Ok(UploadResult {
            version,
            remote_id: Some(gist.id),
        })
    }
}

fn gist_upload_body(encoded: String) -> Value {
    let mut files = serde_json::Map::new();
    files.insert(GIST_FILE_NAME.into(), json!({ "content": encoded }));
    json!({
        "description": "Luma encrypted sync bundle",
        "public": false,
        "files": files
    })
}

#[derive(Debug, Deserialize, Serialize)]
struct GistResponse {
    id: String,
    updated_at: Option<String>,
    #[serde(default)]
    files: std::collections::HashMap<String, GistFile>,
}

#[derive(Debug, Deserialize, Serialize)]
struct GistFile {
    content: Option<String>,
    truncated: Option<bool>,
    raw_url: Option<String>,
}

fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| LumaError::SyncUnavailable("could not initialize the HTTP client".into()))
}

pub(super) fn validate_https_url(value: &str) -> Result<()> {
    let url = reqwest::Url::parse(value)
        .map_err(|_| LumaError::InvalidInput("sync URL is invalid".into()))?;
    if url.scheme() != "https" {
        return Err(LumaError::InvalidInput(
            "remote sync URLs must use HTTPS".into(),
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(LumaError::InvalidInput(
            "sync URL must not contain credentials".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_cloud_api_url(value: &str) -> Result<()> {
    validate_https_url(value)?;
    let url = reqwest::Url::parse(value)
        .map_err(|_| LumaError::InvalidInput("Luma Cloud URL is invalid".into()))?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err(LumaError::InvalidInput(
            "Luma Cloud URL must not contain a query or fragment".into(),
        ));
    }
    Ok(())
}

fn verify_expected_version(
    current: Option<&RemoteBlob>,
    expected_remote_version: Option<&str>,
) -> Result<()> {
    let current_version = current.map(|blob| blob.version.as_str());
    if current_version != expected_remote_version {
        return Err(LumaError::SyncConflict(
            "remote sync data changed since it was downloaded".into(),
        ));
    }
    Ok(())
}

fn content_version(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn sync_io(error: std::io::Error) -> LumaError {
    LumaError::SyncUnavailable(format!("local sync storage is unavailable: {error}"))
}

fn network_error(_: reqwest::Error) -> LumaError {
    LumaError::SyncUnavailable("sync provider could not be reached".into())
}

fn check_auth_or_status(response: &reqwest::Response) -> Result<()> {
    if matches!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    ) {
        return Err(LumaError::SyncAuthFailed(
            "sync provider rejected the configured credentials".into(),
        ));
    }
    if !response.status().is_success() {
        return Err(LumaError::SyncUnavailable(format!(
            "sync provider returned HTTP {}",
            response.status().as_u16()
        )));
    }
    Ok(())
}

fn check_cloud_status(response: &reqwest::Response) -> Result<()> {
    match response.status() {
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => Err(
            LumaError::SyncAuthFailed("Luma Cloud session expired; sign in again".into()),
        ),
        reqwest::StatusCode::PRECONDITION_FAILED => Err(LumaError::SyncConflict(
            "Luma Cloud data changed during upload".into(),
        )),
        reqwest::StatusCode::PAYLOAD_TOO_LARGE => Err(LumaError::SyncUnavailable(
            "Luma Cloud storage quota or size limit was exceeded".into(),
        )),
        status if !status.is_success() => Err(LumaError::SyncUnavailable(format!(
            "Luma Cloud returned HTTP {}",
            status.as_u16()
        ))),
        _ => Ok(()),
    }
}

fn ensure_response_size(response: &reqwest::Response) -> Result<()> {
    ensure_response_size_with_limit(response, MAX_BLOB_BYTES)
}

fn ensure_response_size_with_limit(response: &reqwest::Response, limit: usize) -> Result<()> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(LumaError::SyncUnavailable(
            "sync provider response exceeds the size limit".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_local_folder(path: &Path) -> Result<()> {
    if !path.is_dir() {
        return Err(LumaError::InvalidInput(
            "local sync folder does not exist".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("luma-sync-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn local_folder_roundtrip_and_version_conflict() {
        let directory = temporary_directory();
        let provider = LocalFolderProvider::new(directory.clone());
        assert!(provider.download().await.unwrap().is_none());

        let first = provider.upload(b"first", None).await.unwrap();
        let downloaded = provider.download().await.unwrap().unwrap();
        assert_eq!(downloaded.bytes, b"first");
        assert_eq!(downloaded.version, first.version);

        let error = provider
            .upload(b"second", Some("sha256:stale"))
            .await
            .unwrap_err();
        assert_eq!(error.category(), "sync-conflict");
        assert_eq!(provider.download().await.unwrap().unwrap().bytes, b"first");

        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn local_folder_recovers_stale_lock_with_dead_owner() {
        let directory = temporary_directory();
        let lock_path = directory.join(LOCK_FILE_NAME);
        fs::write(
            &lock_path,
            serde_json::to_vec(&LockOwner {
                process_id: u32::MAX,
                created_at_unix_seconds: unix_timestamp(),
            })
            .unwrap(),
        )
        .unwrap();

        let provider = LocalFolderProvider::new(directory.clone());
        provider.upload(b"recovered", None).await.unwrap();
        assert_eq!(
            provider.download().await.unwrap().unwrap().bytes,
            b"recovered"
        );
        assert!(!lock_path.exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn interrupted_atomic_write_preserves_destination_and_cleans_temp_file() {
        let directory = temporary_directory();
        let destination = directory.join(SYNC_FILE_NAME);
        fs::write(&destination, b"original").unwrap();

        let error = atomic_write_before_replace(&destination, b"replacement", || {
            Err(LumaError::SyncUnavailable("injected interruption".into()))
        })
        .unwrap_err();
        assert_eq!(error.category(), "sync-unavailable");
        assert_eq!(fs::read(&destination).unwrap(), b"original");
        let temp_files = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp-"))
            .collect::<Vec<_>>();
        assert!(temp_files.is_empty(), "temporary files: {temp_files:?}");
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn local_folder_atomic_write_replaces_blob_without_temp_files() {
        let directory = temporary_directory();
        let provider = LocalFolderProvider::new(directory.clone());
        let first = provider.upload(b"first", None).await.unwrap();
        provider
            .upload(b"second", Some(&first.version))
            .await
            .unwrap();
        assert_eq!(fs::read(directory.join(SYNC_FILE_NAME)).unwrap(), b"second");
        let leftovers = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".tmp-") || name == LOCK_FILE_NAME)
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "leftover files: {leftovers:?}");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn remote_urls_require_https_without_embedded_credentials() {
        assert!(validate_https_url("https://example.com/luma.bin").is_ok());
        assert!(validate_https_url("http://example.com/luma.bin").is_err());
        assert!(validate_https_url("https://user:password@example.com/luma.bin").is_err());
        assert!(validate_cloud_api_url("https://sync.example.com").is_ok());
        assert!(validate_cloud_api_url("https://sync.example.com?tenant=other").is_err());
        assert!(validate_cloud_api_url("https://sync.example.com/#fragment").is_err());
    }

    #[test]
    fn gist_payload_uses_the_expected_file_name() {
        let body = gist_upload_body("encrypted-base64".into());
        assert_eq!(body["files"][GIST_FILE_NAME]["content"], "encrypted-base64");
        assert!(body["files"].get("GIST_FILE_NAME").is_none());
    }
}
