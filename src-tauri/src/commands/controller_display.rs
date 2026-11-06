use maa_framework::controller::Controller;

#[derive(Clone, Copy, Default)]
pub struct DisplayOptions {
    pub short: Option<i32>,
    pub long: Option<i32>,
    pub expand: Option<[i32; 2]>,
    pub raw: Option<bool>,
}

impl DisplayOptions {
    pub fn validate(self) -> Result<(), String> {
        let modes = [
            self.short.is_some(),
            self.long.is_some(),
            self.expand.is_some(),
            self.raw == Some(true),
        ];
        let invalid_size = self.short.is_some_and(|v| v <= 0)
            || self.long.is_some_and(|v| v <= 0)
            || self.expand.is_some_and(|size| size.iter().any(|v| *v <= 0));
        if invalid_size || modes.into_iter().filter(|v| *v).count() > 1 {
            return Err("PI_DISPLAY_OPTIONS_INVALID".into());
        }
        Ok(())
    }

    pub fn apply(self, controller: &Controller) -> Result<(), String> {
        self.validate()?;
        let result = if self.raw == Some(true) {
            controller.set_screenshot_use_raw_size(true)
        } else if let Some([width, height]) = self.expand {
            controller.set_screenshot_target_expand(width, height)
        } else if let Some(side) = self.long {
            controller.set_screenshot_target_long_side(side)
        } else {
            controller.set_screenshot_target_short_side(self.short.unwrap_or(720))
        };
        result.map_err(|e| format!("PI_DISPLAY_OPTIONS_UNSUPPORTED: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_modes_are_exclusive_and_dimensions_are_positive() {
        assert!(DisplayOptions::default().validate().is_ok());
        assert!(DisplayOptions {
            raw: Some(false),
            long: Some(1080),
            ..Default::default()
        }
        .validate()
        .is_ok());
        assert!(DisplayOptions {
            raw: Some(true),
            short: Some(720),
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(DisplayOptions {
            expand: Some([1920, 0]),
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(DisplayOptions {
            expand: Some([1920, 1080]),
            ..Default::default()
        }
        .validate()
        .is_ok());
    }
}
