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

    CREATE TABLE IF NOT EXISTS worldcup_matches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fifa_match_id TEXT NOT NULL UNIQUE,
        match_no INTEGER NOT NULL,
        stage TEXT NOT NULL,
        group_name TEXT,
        home_team TEXT NOT NULL,
        away_team TEXT NOT NULL,
        kickoff_utc TEXT NOT NULL,
        kickoff_beijing TEXT NOT NULL,
        venue TEXT NOT NULL,
        city TEXT NOT NULL,
        country TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        source_url TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_worldcup_matches_kickoff ON worldcup_matches (kickoff_utc);
    CREATE INDEX IF NOT EXISTS idx_worldcup_matches_stage ON worldcup_matches (stage, group_name);

    CREATE TABLE IF NOT EXISTS worldcup_team_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_name TEXT NOT NULL,
        alias TEXT NOT NULL,
        language TEXT,
        source_name TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        UNIQUE (team_name, alias)
    );

    CREATE TABLE IF NOT EXISTS worldcup_match_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id INTEGER NOT NULL,
        source_level TEXT NOT NULL,
        source_name TEXT NOT NULL,
        external_match_id TEXT,
        external_issue_no TEXT,
        external_match_no TEXT,
        home_name_raw TEXT NOT NULL,
        away_name_raw TEXT NOT NULL,
        matched_home_team TEXT NOT NULL,
        matched_away_team TEXT NOT NULL,
        confidence REAL NOT NULL,
        verification_status TEXT NOT NULL,
        manually_confirmed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES worldcup_matches (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_worldcup_mappings_match ON worldcup_match_mappings (match_id, source_level);

    CREATE TABLE IF NOT EXISTS worldcup_source_health (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_name TEXT NOT NULL,
        source_level TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        source_url TEXT,
        fetched_at TEXT NOT NULL,
        field_coverage REAL NOT NULL DEFAULT 0,
        failure_rate REAL NOT NULL DEFAULT 0,
        recommended_refresh_seconds INTEGER NOT NULL DEFAULT 3600
    );
    CREATE INDEX IF NOT EXISTS idx_worldcup_source_health_latest ON worldcup_source_health (source_name, fetched_at DESC);

    CREATE TABLE IF NOT EXISTS worldcup_research_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id INTEGER NOT NULL,
        trigger_type TEXT NOT NULL,
        research_model_profile TEXT NOT NULL DEFAULT '{}',
        search_plan_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        evidence_bundle_hash TEXT NOT NULL DEFAULT '',
        estimated_cost REAL NOT NULL DEFAULT 0,
        actual_cost REAL NOT NULL DEFAULT 0,
        FOREIGN KEY (match_id) REFERENCES worldcup_matches (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_worldcup_research_match ON worldcup_research_runs (match_id, id DESC);

    CREATE TABLE IF NOT EXISTS worldcup_evidence_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        research_run_id INTEGER NOT NULL,
        match_id INTEGER NOT NULL,
        category TEXT NOT NULL,
        source_level TEXT NOT NULL,
        source_name TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        published_at TEXT,
        fetched_at TEXT NOT NULL,
        extracted_json TEXT NOT NULL DEFAULT '{}',
        raw_hash TEXT NOT NULL,
        credibility REAL NOT NULL DEFAULT 0,
        rule_check_json TEXT NOT NULL DEFAULT '{}',
        accepted_by_rule INTEGER NOT NULL DEFAULT 0,
        audit_status TEXT NOT NULL,
        FOREIGN KEY (research_run_id) REFERENCES worldcup_research_runs (id) ON DELETE CASCADE,
        FOREIGN KEY (match_id) REFERENCES worldcup_matches (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_worldcup_evidence_match ON worldcup_evidence_items (match_id, audit_status, fetched_at DESC);

    CREATE TABLE IF NOT EXISTS worldcup_audit_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        research_run_id INTEGER NOT NULL,
        auditor_model_profile TEXT NOT NULL DEFAULT '{}',
        conflicts_json TEXT NOT NULL DEFAULT '[]',
        rejected_items_json TEXT NOT NULL DEFAULT '[]',
        accepted_items_json TEXT NOT NULL DEFAULT '[]',
        audit_markdown TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (research_run_id) REFERENCES worldcup_research_runs (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sporttery_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id INTEGER,
        issue_no TEXT,
        game_type TEXT NOT NULL,
        official_match_no TEXT,
        home_team TEXT NOT NULL,
        away_team TEXT NOT NULL,
        sale_start_at TEXT,
        sale_stop_at TEXT,
        draw_date TEXT,
        source_level TEXT NOT NULL,
        source_url TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES worldcup_matches (id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sporttery_events_match ON sporttery_events (match_id, fetched_at DESC);

    CREATE TABLE IF NOT EXISTS sporttery_odds_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sporttery_event_id INTEGER NOT NULL,
        source_level TEXT NOT NULL,
        play_code TEXT NOT NULL,
        selection_code TEXT NOT NULL,
        handicap TEXT,
        odds_value REAL NOT NULL,
        odds_json TEXT NOT NULL DEFAULT '{}',
        is_single_allowed INTEGER NOT NULL DEFAULT 0,
        is_parlay_allowed INTEGER NOT NULL DEFAULT 0,
        sale_status TEXT NOT NULL,
        official_updated_at TEXT,
        fetched_at TEXT NOT NULL,
        source_url TEXT NOT NULL,
        raw_hash TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        is_stale INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (sporttery_event_id) REFERENCES sporttery_events (id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sporttery_odds_event ON sporttery_odds_snapshots (sporttery_event_id, fetched_at DESC);

    CREATE TABLE IF NOT EXISTS worldcup_prediction_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id INTEGER NOT NULL,
        research_run_id INTEGER,
        model_profile TEXT NOT NULL DEFAULT '{}',
        prompt_revision INTEGER NOT NULL DEFAULT 0,
        evidence_bundle_hash TEXT NOT NULL DEFAULT '',
        local_probability TEXT NOT NULL DEFAULT '{}',
        llm_probability TEXT NOT NULL DEFAULT '{}',
        market_probability TEXT NOT NULL DEFAULT '{}',
        final_probability TEXT NOT NULL DEFAULT '{}',
        scoreline_distribution TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0,
        disagreement_score REAL NOT NULL DEFAULT 0,
        analysis_markdown TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES worldcup_matches (id) ON DELETE CASCADE,
        FOREIGN KEY (research_run_id) REFERENCES worldcup_research_runs (id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_worldcup_predictions_match ON worldcup_prediction_runs (match_id, id DESC);

    CREATE TABLE IF NOT EXISTS worldcup_betting_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id INTEGER NOT NULL,
        prediction_run_id INTEGER,
        odds_snapshot_id INTEGER,
        planning_mode TEXT NOT NULL,
        budget REAL NOT NULL DEFAULT 0,
        risk_mode TEXT NOT NULL,
        plan_json TEXT NOT NULL DEFAULT '{}',
        expected_value REAL NOT NULL DEFAULT 0,
        max_loss REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (match_id) REFERENCES worldcup_matches (id) ON DELETE CASCADE,
        FOREIGN KEY (prediction_run_id) REFERENCES worldcup_prediction_runs (id) ON DELETE SET NULL,
        FOREIGN KEY (odds_snapshot_id) REFERENCES sporttery_odds_snapshots (id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_worldcup_plans_match ON worldcup_betting_plans (match_id, id DESC);

    CREATE TABLE IF NOT EXISTS worldcup_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        match_id INTEGER NOT NULL UNIQUE,
        result_json TEXT NOT NULL DEFAULT '{}',
        source_url TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        verified_at TEXT,
        FOREIGN KEY (match_id) REFERENCES worldcup_matches (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS worldcup_plan_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        betting_plan_id INTEGER NOT NULL,
        match_id INTEGER NOT NULL,
        result_id INTEGER,
        generated_odds_snapshot_id INTEGER,
        final_odds_snapshot_id INTEGER,
        hit_status TEXT NOT NULL,
        ev_delta REAL NOT NULL DEFAULT 0,
        attribution_json TEXT NOT NULL DEFAULT '{}',
        notes TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (betting_plan_id) REFERENCES worldcup_betting_plans (id) ON DELETE CASCADE,
        FOREIGN KEY (match_id) REFERENCES worldcup_matches (id) ON DELETE CASCADE,
        FOREIGN KEY (result_id) REFERENCES worldcup_results (id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS worldcup_queue_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        estimated_cost REAL NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
"#;
