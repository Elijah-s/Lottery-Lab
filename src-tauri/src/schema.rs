//! Shared SQLite schema for both tauri-plugin-sql and the native sqlx pool.

pub const INIT_SCHEMA_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS draws (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lottery_type TEXT NOT NULL,
        issue TEXT NOT NULL,
        draw_date TEXT NOT NULL,
        numbers TEXT NOT NULL,
        source_name TEXT,
        source_url TEXT,
        fetched_at TEXT NOT NULL,
        UNIQUE (lottery_type, issue)
    );
    CREATE INDEX IF NOT EXISTS idx_draws_lottery_date ON draws (lottery_type, draw_date DESC);

    CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lottery_type TEXT NOT NULL,
        status TEXT NOT NULL,
        source_name TEXT,
        source_url TEXT,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        degraded INTEGER NOT NULL DEFAULT 0,
        attempts TEXT NOT NULL DEFAULT '[]',
        error_summary TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_runs_lottery_created ON sync_runs (lottery_type, created_at DESC);

    CREATE TABLE IF NOT EXISTS recommendations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lottery_type TEXT NOT NULL,
        target_issue TEXT NOT NULL,
        user_request TEXT NOT NULL,
        parsed_request TEXT NOT NULL,
        recommended_numbers TEXT NOT NULL,
        stake_amount INTEGER NOT NULL,
        heuristic_score REAL NOT NULL,
        rules_version TEXT NOT NULL,
        ticket_text TEXT NOT NULL,
        analysis TEXT NOT NULL DEFAULT '{}',
        candidate_snapshot TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recs_created ON recommendations (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_recs_lottery_target ON recommendations (lottery_type, target_issue);

    CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recommendation_id INTEGER NOT NULL,
        actual_draw TEXT NOT NULL,
        primary_hits INTEGER NOT NULL DEFAULT 0,
        secondary_hits INTEGER NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (recommendation_id) REFERENCES recommendations (id) ON DELETE CASCADE,
        UNIQUE (recommendation_id)
    );

    CREATE TABLE IF NOT EXISTS backtests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lottery_type TEXT NOT NULL,
        request_text TEXT NOT NULL,
        start_issue TEXT NOT NULL,
        end_issue TEXT NOT NULL,
        strategies TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '{}',
        config_snapshot TEXT NOT NULL DEFAULT '{}',
        report_markdown TEXT,
        created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_backtests_created ON backtests (created_at DESC);

    CREATE TABLE IF NOT EXISTS backtest_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backtest_run_id INTEGER NOT NULL,
        strategy_name TEXT NOT NULL,
        issue TEXT NOT NULL,
        generated_numbers TEXT NOT NULL,
        actual_numbers TEXT NOT NULL,
        score_snapshot TEXT NOT NULL DEFAULT '{}',
        hit_summary TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (backtest_run_id) REFERENCES backtests (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_samples_run ON backtest_samples (backtest_run_id, strategy_name);

    CREATE TABLE IF NOT EXISTS prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role_name TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL,
        prompt_revision INTEGER NOT NULL DEFAULT 1,
        prompt_hash TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
"#;
