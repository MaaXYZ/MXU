use std::collections::HashSet;
use std::sync::{LazyLock, RwLock};

static SECRETS: LazyLock<RwLock<HashSet<String>>> = LazyLock::new(|| RwLock::new(HashSet::new()));

pub fn register(secrets: &[String]) {
    let mut values = SECRETS.write().unwrap_or_else(|e| e.into_inner());
    for secret in secrets.iter().filter(|value| !value.is_empty()) {
        values.insert(secret.clone());
        if let Ok(json) = serde_json::to_string(secret) {
            values.insert(json[1..json.len() - 1].to_owned());
        }
    }
}

pub fn redact(text: &str) -> String {
    let values = SECRETS.read().unwrap_or_else(|e| e.into_inner());
    let mut values: Vec<&String> = values.iter().collect();
    values.sort_by_key(|value| std::cmp::Reverse(value.len()));
    values.into_iter().fold(text.to_owned(), |text, secret| {
        text.replace(secret.as_str(), "******")
    })
}

pub fn redact_serializable<T: serde::Serialize + serde::de::DeserializeOwned>(
    value: T,
) -> Option<T> {
    fn clean(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::String(text) => *text = redact(text),
            serde_json::Value::Array(values) => values.iter_mut().for_each(clean),
            serde_json::Value::Object(values) => values.values_mut().for_each(clean),
            _ => {}
        }
    }
    let mut value = serde_json::to_value(value).ok()?;
    clean(&mut value);
    serde_json::from_value(value).ok()
}

#[tauri::command]
pub fn register_log_secrets(secrets: Vec<String>) {
    register(&secrets);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_plain_and_json_escaped_passwords() {
        let secret = "unique-audit-password\\\"test".to_string();
        register(&[secret.clone()]);
        assert_eq!(redact(&secret), "******");
        assert_eq!(
            redact(&serde_json::to_string(&secret).unwrap()),
            "\"******\""
        );
    }

    #[test]
    fn telemetry_redaction_preserves_structure_and_non_string_values() {
        let secret = "unique-telemetry-token".to_string();
        register(&[secret.clone()]);
        let event =
            serde_json::json!({"message": secret, "trace": true, "code": 123, "tags": [secret]});
        assert_eq!(
            redact_serializable(event),
            Some(
                serde_json::json!({"message":"******", "trace":true, "code":123, "tags":["******"]})
            )
        );
    }
}
