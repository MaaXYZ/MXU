/**
 * 通用表单控件组件
 * 可在 ActionItem、OptionEditor 等处复用
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import clsx from 'clsx';
import { open } from '@tauri-apps/plugin-dialog';
import { isTauri } from '@tauri-apps/api/core';

interface BaseFieldProps {
  label: string;
  hint?: string;
  disabled?: boolean;
}

// ============ SwitchButton 开关按钮（纯按钮，无标签） ============

interface SwitchButtonProps {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  tabIndex?: number;
}

export function SwitchButton({ value, onChange, disabled, tabIndex }: SwitchButtonProps) {
  return (
    <button
      onClick={() => !disabled && onChange(!value)}
      disabled={disabled}
      tabIndex={tabIndex}
      className={clsx(
        'relative w-11 h-6 rounded-full transition-colors flex-shrink-0',
        value ? 'bg-accent' : 'bg-bg-active',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span
        className={clsx(
          'absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200',
          value ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}

// ============ SwitchField 开关字段（带标签和提示） ============

interface SwitchFieldProps extends BaseFieldProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

export function SwitchField({ label, hint, value, onChange, disabled }: SwitchFieldProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <label className="text-xs text-text-secondary">{label}</label>
        <SwitchButton value={value} onChange={onChange} disabled={disabled} />
      </div>
      {hint && <p className="text-[10px] text-text-muted">{hint}</p>}
    </div>
  );
}

// ============ TextInput 文本输入框（纯输入框，无标签） ============

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  hasError?: boolean;
  className?: string;
  type?: 'text' | 'number' | 'password';
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  step?: number;
  integerOnly?: boolean;
}

interface HotkeyInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

interface BuildHotkeyComboOptions {
  /** 保留 Meta（Command/Windows）语义；默认仍归一为 Ctrl，以兼容应用全局快捷键。 */
  preserveMeta?: boolean;
  /** 将 KeyboardEvent.key 规范化为流水线热键表使用的键名。 */
  normalizePipelineKey?: boolean;
}

const PIPELINE_HOTKEY_KEY_NAMES: Record<string, string> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Escape: 'Esc',
  ' ': 'Space',
  Spacebar: 'Space',
};

export function TextInput({
  value,
  onChange,
  placeholder,
  disabled,
  hasError,
  className,
  type = 'text',
  inputMode,
  step,
  integerOnly,
}: TextInputProps) {
  return (
    <input
      type={type}
      autoComplete={type === 'password' ? 'off' : undefined}
      value={value}
      onChange={(e) => {
        if (!integerOnly) {
          onChange(e.target.value);
          return;
        }
        const raw = e.target.value;
        if (raw === '' || raw === '-') {
          onChange(raw);
          return;
        }
        const cleaned = raw.replace(/[^\d-]/g, '');
        const hasLeadingMinus = cleaned.startsWith('-');
        const normalized = `${hasLeadingMinus ? '-' : ''}${cleaned.replace(/-/g, '')}`;
        onChange(normalized);
      }}
      placeholder={placeholder}
      disabled={disabled}
      inputMode={inputMode}
      step={step}
      className={clsx(
        'px-3 py-1.5 text-sm rounded-md border',
        'bg-bg-secondary text-text-primary',
        'focus:outline-none focus:ring-1',
        disabled && 'opacity-60 cursor-not-allowed',
        hasError
          ? 'border-error focus:border-error focus:ring-error/20'
          : 'border-border focus:border-accent focus:ring-accent/20',
        className,
      )}
    />
  );
}

// ============ TextField 文本字段（带标签和提示） ============

interface TextFieldProps extends BaseFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function TextField({ label, hint, value, onChange, placeholder, disabled }: TextFieldProps) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-text-secondary">{label}</label>
      <TextInput
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        className="w-full"
      />
      {hint && <p className="text-[10px] text-text-muted">{hint}</p>}
    </div>
  );
}

// ============ NumberInput 数字输入框（纯输入框，无标签） ============

interface NumberInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  className?: string;
}

export function NumberInput({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  disabled,
  className,
}: NumberInputProps) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => {
        const v = parseFloat(e.target.value);
        let result = isNaN(v) ? min : Math.max(min, v);
        if (max !== undefined) result = Math.min(max, result);
        onChange(result);
      }}
      disabled={disabled}
      className={clsx(
        'w-24 px-3 py-1.5 text-sm rounded-md border',
        'bg-bg-secondary text-text-primary border-border',
        'focus:outline-none focus:ring-1 focus:ring-accent/20 focus:border-accent',
        disabled && 'opacity-60 cursor-not-allowed',
        className,
      )}
    />
  );
}

// ============ NumberField 数字字段（带标签和提示） ============

interface NumberFieldProps extends BaseFieldProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}

export function NumberField({
  label,
  hint,
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  suffix,
  disabled,
}: NumberFieldProps) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-text-secondary">{label}</label>
      <div className="flex items-center gap-2">
        <NumberInput
          value={value}
          onChange={onChange}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
        />
        {suffix && <span className="text-xs text-text-muted">{suffix}</span>}
      </div>
      {hint && <p className="text-[10px] text-text-muted">{hint}</p>}
    </div>
  );
}

// ============ TimeInput 时间选择器（HH:MM 格式，无标签） ============

interface TimeInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * 从键盘事件生成统一的快捷键组合字符串（如 "Ctrl+Shift+A"）。
 * 纯修饰键（Ctrl/Shift/Alt/Meta）单独按下时返回 null。
 * 默认将 Meta 归一为 Ctrl，保持应用全局快捷键的 CommandOrControl 兼容语义；
 * 流水线热键可保留 Command/Windows 键语义，并将浏览器键名规范化为协议映射表键名。
 */
export function buildHotkeyCombo(
  e: React.KeyboardEvent,
  { preserveMeta = false, normalizePipelineKey = false }: BuildHotkeyComboOptions = {},
): string | null {
  const parts: string[] = [];
  if (e.ctrlKey || (e.metaKey && !preserveMeta)) parts.push('Ctrl');
  if (e.metaKey && preserveMeta) parts.push('Meta');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  let key = e.key as string;
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') {
    return null;
  }
  if (normalizePipelineKey) {
    key = PIPELINE_HOTKEY_KEY_NAMES[key] ?? key;
  }
  if (/^f\d+$/i.test(key) || key.length === 1) {
    key = key.toUpperCase();
  }

  parts.push(key);
  return parts.join('+');
}

const SETTINGS_HOTKEY_MODIFIERS = new Set(['Ctrl', 'Alt', 'Shift', 'Meta']);

/** 设置里的开始/结束快捷键：单独按键仅 F1–F24，其余必须带修饰键。 */
export function isAllowedSettingsHotkey(combo: string): boolean {
  const parts = combo.split('+').filter(Boolean);
  if (parts.length === 0) return false;

  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  if (modifiers.length === 0) {
    return /^F([1-9]|1\d|2[0-4])$/i.test(key);
  }

  const modifiersOk = modifiers.every((modifier) => SETTINGS_HOTKEY_MODIFIERS.has(modifier));
  return modifiersOk && !SETTINGS_HOTKEY_MODIFIERS.has(key);
}

export function HotkeyInput({
  value,
  onChange,
  placeholder,
  disabled,
  className,
}: HotkeyInputProps) {
  const { t } = useTranslation();
  const [capturing, setCapturing] = useState(false);

  return (
    <input
      type="text"
      readOnly
      value={value}
      placeholder={
        capturing
          ? t('optionEditor.hotkeyCapturing')
          : placeholder || t('optionEditor.hotkeyPlaceholder')
      }
      disabled={disabled}
      onFocus={() => !disabled && setCapturing(true)}
      onBlur={() => setCapturing(false)}
      onKeyDown={(e) => {
        if (disabled) return;
        e.preventDefault();
        const combo = buildHotkeyCombo(e, {
          preserveMeta: true,
          normalizePipelineKey: true,
        });
        if (!combo) return;
        onChange(combo);
      }}
      className={clsx(
        'px-3 py-1.5 text-sm rounded-md border cursor-pointer',
        'bg-bg-secondary text-text-primary',
        'focus:outline-none focus:ring-1 focus:border-accent focus:ring-accent/20 border-border',
        disabled && 'opacity-60 cursor-not-allowed',
        className,
      )}
    />
  );
}

export function TimeInput({ value, onChange, disabled, className }: TimeInputProps) {
  return (
    <input
      type="time"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={clsx(
        'px-3 py-1.5 text-sm rounded-md border',
        'bg-bg-secondary text-text-primary border-border',
        'focus:outline-none focus:ring-1 focus:ring-accent/20 focus:border-accent',
        disabled && 'opacity-60 cursor-not-allowed',
        className,
      )}
    />
  );
}

// ============ FileInput 文件路径输入框（纯输入框+浏览按钮，无标签） ============

interface FileInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  filters?: { name: string; extensions: string[] }[];
  browseTitle?: string;
  className?: string;
}

const defaultFileFilters = [
  { name: 'Executable', extensions: ['exe', 'bat', 'cmd', 'ps1', 'sh'] },
  { name: 'All Files', extensions: ['*'] },
];

export function FileInput({
  value,
  onChange,
  placeholder,
  disabled,
  filters = defaultFileFilters,
  browseTitle,
  className,
}: FileInputProps) {
  const { t } = useTranslation();

  const handleSelectFile = async () => {
    if (!isTauri() || disabled) return;

    try {
      const selected = await open({
        multiple: false,
        filters,
      });

      if (selected && typeof selected === 'string') {
        onChange(selected);
      }
    } catch (err) {
      console.error('Failed to open file dialog:', err);
    }
  };

  return (
    <div className={clsx('flex min-w-0 gap-2', className)}>
      <TextInput
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        className="min-w-0 flex-1"
      />
      {isTauri() && (
        <button
          onClick={handleSelectFile}
          disabled={disabled}
          className={clsx(
            'px-2.5 py-1.5 rounded-md border border-border',
            'bg-bg-secondary hover:bg-bg-hover text-text-secondary',
            'transition-colors',
            disabled && 'opacity-60 cursor-not-allowed',
          )}
          title={browseTitle || t('action.browse')}
        >
          <FolderOpen className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

// ============ FileField 文件字段（带标签和提示） ============

interface FileFieldProps extends BaseFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  filters?: { name: string; extensions: string[] }[];
}

export function FileField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  filters,
  disabled,
}: FileFieldProps) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-text-secondary">{label}</label>
      <FileInput
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        filters={filters}
        disabled={disabled}
      />
      {hint && <p className="text-[10px] text-text-muted">{hint}</p>}
    </div>
  );
}
