//! Lottery Lab — Tauri shell entry point.
//!
//! A native sqlx pool powers the Rust commands, while tauri-plugin-sql
//! remains available to the front-end. Both use the same idempotent
//! schema SQL so startup order cannot leave commands pointing at an
//! empty database.

use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

mod backtest;
mod commands;
mod db;
mod errors;
mod llm;
mod prompts;
mod recommendation;
mod reviews;
mod schema;
mod scheduler;
mod settings;
mod sources;
mod state;
mod sync;
mod time_utils;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好，{name}！彩票实验室已就绪。")
}

fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "init schema: draws / sync_runs / recommendations / reviews / backtests / backtest_samples / prompts / app_settings",
        sql: schema::INIT_SCHEMA_SQL,
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:lottery_lab.db", migrations())
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            let pool = tauri::async_runtime::block_on(async {
                let pool = db::open_pool(&handle).await?;
                prompts::seed_defaults(&pool).await?;
                settings::load_settings(&pool).await?;
                Ok::<_, crate::errors::AppError>(pool)
            });
            let pool = pool.map_err(|err| {
                log::error!(target: "setup", "failed to initialize app state: {err}");
                err
            })?;
            handle.manage(state::AppState { pool: pool.clone() });
            scheduler::spawn_background_sync(&handle, pool);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::sync_draws,
            commands::list_draws,
            commands::list_sync_runs,
            commands::create_recommendation,
            commands::list_recommendations,
            commands::delete_recommendations,
            commands::review_pending,
            commands::list_reviews,
            commands::save_backtest,
            commands::list_backtests,
            commands::get_backtest_samples,
            commands::export_backtest,
            commands::get_prompts,
            commands::save_prompts,
            commands::reset_prompts,
            commands::get_ai_settings,
            commands::save_ai_settings,
            commands::list_llm_models,
            commands::test_llm_connection,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
