import { type CSSProperties, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe, Palette, Image } from 'lucide-react';
import clsx from 'clsx';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';

import { useAppStore } from '@/stores/appStore';
import { getAccentInfoList, type AccentColor, type CustomAccent } from '@/themes';
import { SortableAccentTile } from './SortableAccentTile';
import { isTauri } from '@/utils/windowUtils';
import { BuiltinSkinCompanion } from '@/components/skins/BuiltinSkinCompanion';
import deepseekThumbnail from '@/assets/skins/deepseek.png';
import naiwaThumbnail from '@/assets/skins/naiwa-calm.png';
import deepseekLicense from '@/assets/skins/LICENSE.deepseek.txt?raw';

interface AppearanceSectionProps {
  onOpenCreateAccentModal: () => void;
  onOpenEditAccentModal: (accent: CustomAccent) => void;
  onDeleteAccent: (id: string) => void;
}

export function AppearanceSection({
  onOpenCreateAccentModal,
  onOpenEditAccentModal,
  onDeleteAccent,
}: AppearanceSectionProps) {
  const { t } = useTranslation();
  const {
    theme,
    setTheme,
    skinId,
    setSkinId,
    skinReducedMotion,
    setSkinReducedMotion,
    accentColor,
    setAccentColor,
    customAccents,
    reorderCustomAccents,
    language,
    setLanguage,
    backgroundImage,
    setBackgroundImage,
    backgroundOpacity,
    setBackgroundOpacity,
  } = useAppStore();

  // 获取强调色列表（包含自定义强调色）
  const accentColors = useMemo(
    () => getAccentInfoList(language, customAccents),
    [language, customAccents],
  );

  const customAccentIds = useMemo(() => customAccents.map((a) => a.id), [customAccents]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleAccentDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = customAccentIds.indexOf(String(active.id));
      const newIndex = customAccentIds.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) return;
      reorderCustomAccents(oldIndex, newIndex);
    },
    [customAccentIds, reorderCustomAccents],
  );

  const handleLanguageChange = (
    lang: 'system' | 'zh-CN' | 'zh-TW' | 'en-US' | 'ja-JP' | 'ko-KR',
  ) => {
    setLanguage(lang);
  };

  return (
    <section id="section-appearance" className="space-y-4 scroll-mt-4">
      <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider flex items-center gap-2">
        <Palette className="w-4 h-4" />
        {t('settings.appearance')}
      </h2>

      {/* 语言 */}
      <div className="bg-bg-secondary rounded-xl p-4 border border-border">
        <div className="flex items-center gap-3 mb-3">
          <Globe className="w-5 h-5 text-accent" />
          <span className="font-medium text-text-primary">{t('settings.language')}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {(['system', 'zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR'] as const).map((lang) => (
            <button
              key={lang}
              onClick={() => handleLanguageChange(lang)}
              className={clsx(
                'px-4 py-2.5 rounded-lg text-sm font-medium transition-colors',
                language === lang
                  ? 'bg-accent text-white'
                  : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
              )}
            >
              {lang === 'system'
                ? t('settings.languageSystem')
                : lang === 'zh-CN'
                  ? '简体中文'
                  : lang === 'zh-TW'
                    ? '繁體中文'
                    : lang === 'en-US'
                      ? 'English'
                      : lang === 'ja-JP'
                        ? '日本語'
                        : '한국어'}
            </button>
          ))}
        </div>
      </div>

      {/* 主题 */}
      <div className="bg-bg-secondary rounded-xl p-4 border border-border">
        <div className="flex items-center gap-3 mb-3">
          <Palette className="w-5 h-5 text-accent" />
          <span className="font-medium text-text-primary">{t('settings.theme')}</span>
        </div>
        <div className="flex gap-2">
          {(['system', 'light', 'dark'] as const).map((t_) => (
            <button
              key={t_}
              onClick={() => setTheme(t_)}
              className={clsx(
                'flex-1 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors',
                theme === t_
                  ? 'bg-accent text-white'
                  : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
              )}
            >
              {t(`settings.theme${t_.charAt(0).toUpperCase() + t_.slice(1)}`)}
            </button>
          ))}
        </div>
      </div>

      {/* 内置皮肤 */}
      <div className="bg-bg-secondary rounded-xl p-4 border border-border space-y-3">
        <div className="flex items-center gap-3">
          <Palette className="w-5 h-5 text-accent" aria-hidden="true" />
          <span id="settings-skin-label" className="font-medium text-text-primary">
            {t('settings.skin')}
          </span>
        </div>
        <p id="settings-skin-hint" className="text-sm text-text-secondary">
          {t('settings.skinHint')}
        </p>
        <div
          role="group"
          aria-labelledby="settings-skin-label"
          aria-describedby="settings-skin-hint"
          className="grid grid-cols-3 gap-2"
        >
          {(['default', 'deepseek', 'naiwa'] as const).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={skinId === id}
              onClick={() => setSkinId(id)}
              className={clsx(
                'flex min-w-0 flex-col items-center gap-2 rounded-lg border px-2 py-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                skinId === id
                  ? 'border-accent bg-accent/10 text-text-primary'
                  : 'border-border bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
              )}
            >
              <span className="flex h-20 w-full items-center justify-center" aria-hidden="true">
                {id === 'default' ? (
                  <Palette className="h-10 w-10 text-text-muted" />
                ) : (
                  <img
                    src={id === 'deepseek' ? deepseekThumbnail : naiwaThumbnail}
                    alt=""
                    className={clsx(
                      'pointer-events-none h-full max-w-full',
                      id === 'deepseek' ? 'w-20 object-cover' : 'object-contain',
                    )}
                  />
                )}
              </span>
              <span className="text-center">
                {t(
                  id === 'default'
                    ? 'settings.skinDefault'
                    : id === 'deepseek'
                      ? 'settings.skinDeepseek'
                      : 'settings.skinNaiwa',
                )}
              </span>
            </button>
          ))}
        </div>
        {skinId === 'deepseek' && (
          <details className="text-xs text-text-secondary">
            <summary className="cursor-pointer">{t('settings.skinAssetLicense')}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-bg-tertiary p-3 font-sans">
              {deepseekLicense}
            </pre>
          </details>
        )}
        <div className="border-t border-border pt-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-primary">
            <input
              type="checkbox"
              checked={skinReducedMotion}
              onChange={(event) => setSkinReducedMotion(event.target.checked)}
              aria-describedby="settings-skin-motion-hint"
              className="h-4 w-4 accent-accent"
            />
            {t('settings.skinReducedMotion')}
          </label>
          <p id="settings-skin-motion-hint" className="mt-1 text-xs text-text-muted">
            {t('settings.skinReducedMotionHint')}
          </p>
        </div>
        {skinId !== 'default' && (
          <div className="rounded-lg bg-bg-tertiary p-3">
            <p className="mb-2 text-xs font-medium text-text-secondary">
              {t('settings.skinPreview')}
            </p>
            <BuiltinSkinCompanion preview />
          </div>
        )}
      </div>

      {/* 强调色 */}
      <div className="bg-bg-secondary rounded-xl p-4 border border-border space-y-4">
        <div className="flex items-center gap-3 mb-3">
          <Palette className="w-5 h-5 text-accent" />
          <span className="font-medium text-text-primary">{t('settings.accentColor')}</span>
        </div>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleAccentDragEnd}
        >
          <SortableContext items={customAccentIds} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-3 gap-2">
              {accentColors.map((accent) => {
                const isSelected = accentColor === accent.name;
                if (accent.isCustom) {
                  const customAccent = customAccents.find((a) => a.name === accent.name);
                  if (!customAccent) return null;
                  return (
                    <SortableAccentTile
                      key={customAccent.id}
                      accent={accent}
                      customAccent={customAccent}
                      isSelected={isSelected}
                      onSelect={() => setAccentColor(accent.name as AccentColor)}
                      onEdit={() => onOpenEditAccentModal(customAccent)}
                      onDelete={() => onDeleteAccent(customAccent.id)}
                    />
                  );
                }

                return (
                  <button
                    key={accent.name}
                    onClick={() => setAccentColor(accent.name as AccentColor)}
                    className={clsx(
                      'relative flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors bg-bg-tertiary border',
                      isSelected
                        ? 'ring-2 ring-offset-2 ring-offset-bg-secondary border-transparent'
                        : 'border-border hover:bg-bg-hover',
                    )}
                    style={
                      isSelected
                        ? ({ '--tw-ring-color': accent.color } as CSSProperties)
                        : undefined
                    }
                  >
                    <span
                      className="w-4 h-4 rounded-full flex-shrink-0 border border-border-strong"
                      style={{ backgroundColor: accent.color }}
                    />
                    <span className="truncate text-text-secondary">{accent.label}</span>
                  </button>
                );
              })}

              {/* + 新增自定义强调色 */}
              <button
                type="button"
                onClick={onOpenCreateAccentModal}
                className="flex items-center justify-center px-3 py-2 rounded-lg text-sm font-medium bg-bg-tertiary border-2 border-dashed border-border hover:bg-bg-hover text-text-muted transition-colors"
                title={t('settings.addCustomAccent')}
              >
                <span className="text-sm">+</span>
              </button>
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {/* 背景图片 */}
      <div className="bg-bg-secondary rounded-xl p-4 border border-border space-y-4">
        <div className="flex items-center gap-3 mb-3">
          <Image className="w-5 h-5 text-accent" />
          <span className="font-medium text-text-primary">{t('settings.backgroundImage')}</span>
        </div>
        <div className="space-y-3">
          <div className="flex gap-2">
            <button
              onClick={async () => {
                if (!isTauri()) return;
                try {
                  const { open } = await import('@tauri-apps/plugin-dialog');
                  const file = await open({
                    multiple: false,
                    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
                  });
                  if (Array.isArray(file)) {
                    if (file[0]) setBackgroundImage(file[0]);
                  } else if (file) {
                    setBackgroundImage(file);
                  }
                } catch (err) {
                  console.error('Failed to select background image:', err);
                }
              }}
              disabled={!isTauri()}
              className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium bg-bg-tertiary text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('settings.selectBackgroundImage')}
            </button>
            {backgroundImage && (
              <button
                onClick={() => setBackgroundImage(undefined)}
                className="px-4 py-2.5 rounded-lg text-sm font-medium bg-bg-tertiary text-text-secondary hover:bg-bg-hover transition-colors"
              >
                {t('settings.removeBackgroundImage')}
              </button>
            )}
          </div>
          {backgroundImage && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-secondary">
                  {t('settings.backgroundOpacity')}
                </span>
                <span className="text-sm text-text-primary font-medium">{backgroundOpacity}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={backgroundOpacity}
                onChange={(e) => setBackgroundOpacity(Number(e.target.value))}
                className="w-full"
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
