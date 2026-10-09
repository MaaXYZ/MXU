import { useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Keyboard, Play, StopCircle, AlertCircle, Globe } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { SwitchButton, buildHotkeyCombo, isAllowedSettingsHotkey } from '@/components/FormControls';
import { DesktopOnlyWrapper } from '@/components/ui/DesktopOnlyWrapper';

export function HotkeySection() {
  const { t } = useTranslation();
  const { hotkeys, setHotkeys } = useAppStore();
  const globalHotkeyError = useAppStore((state) => state.globalHotkeyError);
  const [captureRejected, setCaptureRejected] = useState(false);
  const savedHotkeyInvalid =
    !isAllowedSettingsHotkey(hotkeys.startTasks) || !isAllowedSettingsHotkey(hotkeys.stopTasks);

  const captureHotkey = (field: 'startTasks' | 'stopTasks', event: KeyboardEvent) => {
    event.preventDefault();
    const combo = buildHotkeyCombo(event);
    if (!combo) return;
    if (!isAllowedSettingsHotkey(combo)) {
      setCaptureRejected(true);
      return;
    }
    setCaptureRejected(false);
    setHotkeys({
      ...hotkeys,
      [field]: combo,
    });
  };

  return (
    <section id="section-hotkeys" className="space-y-4 scroll-mt-4">
      <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider flex items-center gap-2">
        <Keyboard className="w-4 h-4" />
        {t('settings.hotkeys')}
      </h2>

      <DesktopOnlyWrapper>
        <div className="bg-bg-secondary rounded-xl p-4 border border-border space-y-4">
          <p className="text-xs text-text-muted">{t('settings.hotkeysHint')}</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* 开始任务快捷键 */}
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
                <Play className="w-3 h-3 text-accent" />
                <span>{t('settings.hotkeysStartTasks')}</span>
              </label>
              <input
                type="text"
                readOnly
                value={hotkeys.startTasks}
                placeholder="F10"
                onKeyDown={(e) => captureHotkey('startTasks', e)}
                className="w-full px-3 py-2 rounded-lg bg-bg-tertiary border border-border text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50 cursor-pointer"
              />
            </div>

            {/* 结束任务快捷键 */}
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
                <StopCircle className="w-3 h-3 text-accent" />
                <span>{t('settings.hotkeysStopTasks')}</span>
              </label>
              <input
                type="text"
                readOnly
                value={hotkeys.stopTasks}
                placeholder="F11"
                onKeyDown={(e) => captureHotkey('stopTasks', e)}
                className="w-full px-3 py-2 rounded-lg bg-bg-tertiary border border-border text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50 cursor-pointer"
              />
            </div>
          </div>

          {(captureRejected || savedHotkeyInvalid) && (
            <div className="flex items-center gap-2 text-xs text-warning">
              <AlertCircle className="w-3 h-3" />
              <span>{t('settings.hotkeysModifierRequired')}</span>
            </div>
          )}

          {hotkeys.startTasks === hotkeys.stopTasks && (
            <div className="flex items-center gap-2 text-xs text-warning">
              <AlertCircle className="w-3 h-3" />
              <span>
                {t('settings.hotkeysConflict')}
                {hotkeys.globalEnabled && ` (${t('settings.hotkeysGlobalOnlyStart')})`}
              </span>
            </div>
          )}

          {/* 全局快捷键注册失败提示 */}
          {globalHotkeyError && (
            <div className="flex items-start gap-2 px-2.5 py-1.5 rounded-md bg-error/10 text-error text-xs">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>
                {globalHotkeyError.conflict
                  ? t('settings.hotkeysGlobalConflict', { combo: globalHotkeyError.combo })
                  : t('settings.hotkeysGlobalRegisterFailed', {
                      combo: globalHotkeyError.combo,
                      error: globalHotkeyError.message,
                    })}
              </span>
            </div>
          )}

          {/* 全局快捷键开关 */}
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <div className="flex items-center gap-3">
              <Globe className="w-5 h-5 text-accent" />
              <div>
                <span className="font-medium text-text-primary">{t('settings.hotkeysGlobal')}</span>
                <p className="text-xs text-text-muted mt-0.5">{t('settings.hotkeysGlobalHint')}</p>
              </div>
            </div>
            <SwitchButton
              value={hotkeys.globalEnabled ?? false}
              onChange={(v) => setHotkeys({ ...hotkeys, globalEnabled: v })}
            />
          </div>
        </div>
      </DesktopOnlyWrapper>
    </section>
  );
}
