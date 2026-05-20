//! SQLite access for Rust-side services.
//!
//! `tauri-plugin-sql` exposes a JS-facing API but does not give us a
//! typed `Pool` for native Rust commands. We therefore maintain a
//! parallel `sqlx` pool pointing at the same DB file. The native pool
//! applies the shared idempotent schema on open so Rust commands do not
//! depend on the front-end opening the plugin connection first.

use std::path::PathBuf;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use tauri::{AppHandle, Manager};

use crate::errors::{AppError, AppResult};
use crate::schema;

const DB_FILENAME: &str = "lottery_lab.db";

/// Resolve the on-disk path the plugin uses. Must match the URL
/// passed to `tauri_plugin_sql`: `sqlite:lottery_lab.db` lives inside
/// the app data directory.
fn resolve_db_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|err| AppError::Config(format!("无法获取 app 数据目录：{err}")))?;
    std::fs::create_dir_all(&dir)
        .map_err(|err| AppError::Config(format!("创建 app 数据目录失败：{err}")))?;
    Ok(dir.join(DB_FILENAME))
}

pub async fn open_pool(app: &AppHandle) -> AppResult<SqlitePool> {
    let path = resolve_db_path(app)?;
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .map_err(AppError::from)?;

    sqlx::raw_sql(schema::INIT_SCHEMA_SQL)
        .execute(&pool)
        .await?;

    Ok(pool)
}
