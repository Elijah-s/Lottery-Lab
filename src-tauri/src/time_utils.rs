//! Time helpers — centralised here so we stay consistent on Beijing time.

use chrono::{DateTime, FixedOffset, Utc};

/// Beijing time offset (UTC+8), hard-coded because lottery draws are
/// published in CST regardless of where the app happens to run.
pub fn beijing_offset() -> FixedOffset {
    FixedOffset::east_opt(8 * 3600).expect("valid offset")
}

pub fn now_beijing() -> DateTime<FixedOffset> {
    Utc::now().with_timezone(&beijing_offset())
}

pub fn now_beijing_iso() -> String {
    now_beijing().format("%Y-%m-%d %H:%M:%S").to_string()
}
