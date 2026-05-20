//! Lightweight daily scheduler driving draw sync in the background.
//!
//! We don't need a full cron library here — a single tokio task that
//! sleeps until the next scheduled run (plus the initial sync on app
//! startup) is enough for our "once a day" cadence.

use std::time::Duration;

use log::{info, warn};
use sqlx::SqlitePool;
use tauri::AppHandle;
use tokio::time;

use crate::sync::{SyncService, DEFAULT_LOOKBACK};

const DAILY_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

pub fn spawn_background_sync(_app: &AppHandle, pool: SqlitePool) {
    tauri::async_runtime::spawn(async move {
        // First attempt right after startup; swallow the result so a
        // failure doesn't kill the scheduler.
        info!(target: "scheduler", "initial sync kicking off");
        let service = SyncService::new(pool.clone());
        let _ = service.sync_all(DEFAULT_LOOKBACK).await;

        loop {
            time::sleep(DAILY_INTERVAL).await;
            info!(target: "scheduler", "periodic sync tick");
            let service = SyncService::new(pool.clone());
            match time::timeout(
                Duration::from_secs(180),
                service.sync_all(DEFAULT_LOOKBACK),
            )
            .await
            {
                Ok(_) => {}
                Err(_) => {
                    warn!(target: "scheduler", "periodic sync timed out");
                }
            }
        }
    });
}
