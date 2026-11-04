import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2, Sparkles, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import {
  markdownToHtml,
  markdownToHtmlWithLocalImages,
  resolveContent,
  resolveI18nText,
} from '@/services/contentResolver';
import { getInterfaceLangKey } from '@/i18n';
import { loggers } from '@/utils/logger';
import { ModalPortal, useModalFocusTrap } from '@/components/ui/Modal';
import { getWelcomeContentHash, resolveWelcomeEntries } from '@/utils/welcomeContent';

type WelcomeContentState =
  | { status: 'loading'; html: ''; hash: '' }
  | { status: 'empty'; html: ''; hash: '' }
  | { status: 'ready'; html: string; hash: string };

interface WelcomeDialogViewProps {
  html: string;
  isLoading?: boolean;
  onClose: () => void;
  title: string;
}

interface ManualWelcomeDialogProps {
  onClose: () => void;
}

/**
 * 解析当前语言下的 welcome 内容。
 * URL、ETag 缓存、本地文件和 Markdown 渲染统一从这里进入，展示策略不参与解析。
 */
function useWelcomeContent() {
  const projectInterface = useAppStore((state) => state.projectInterface);
  const interfaceTranslations = useAppStore((state) => state.interfaceTranslations);
  const basePath = useAppStore((state) => state.basePath);
  const language = useAppStore((state) => state.language);

  const welcome = projectInterface?.welcome;
  const hasWelcome = Array.isArray(welcome) ? welcome.length > 0 : Boolean(welcome);
  const langKey = getInterfaceLangKey(language);
  const translations = interfaceTranslations[langKey];
  const title =
    resolveI18nText(projectInterface?.label, translations) || projectInterface?.name || 'Welcome';

  const [content, setContent] = useState<WelcomeContentState>(() =>
    hasWelcome
      ? { status: 'loading', html: '', hash: '' }
      : { status: 'empty', html: '', hash: '' },
  );

  useEffect(() => {
    let cancelled = false;

    if (!hasWelcome) {
      setContent({ status: 'empty', html: '', hash: '' });
      return;
    }

    setContent({ status: 'loading', html: '', hash: '' });

    const loadWelcome = async () => {
      const entries = await resolveWelcomeEntries(welcome, (source) =>
        resolveContent(source, { translations, basePath }),
      );
      if (cancelled) return;

      if (entries.every((entry) => !entry.content)) {
        setContent({ status: 'empty', html: '', hash: '' });
        return;
      }

      // 独立渲染，避免上一条公告未闭合的 Markdown 影响下一条。
      const htmls = await Promise.all(
        entries
          .filter((entry) => entry.content)
          .map(async ({ content }) => {
            try {
              return await markdownToHtmlWithLocalImages(content, basePath);
            } catch (err) {
              loggers.ui.warn('Welcome markdown 转 HTML 失败，降级为纯 markdown 渲染:', err);
              return markdownToHtml(content);
            }
          }),
      );

      if (cancelled) return;
      setContent({
        status: 'ready',
        html: htmls.join('<hr />'),
        hash: getWelcomeContentHash(entries),
      });
    };

    void loadWelcome().catch((err) => {
      if (cancelled) return;
      loggers.ui.warn('Welcome 内容解析失败:', err);
      setContent({ status: 'empty', html: '', hash: '' });
    });

    return () => {
      cancelled = true;
    };
  }, [welcome, hasWelcome, langKey, basePath, translations]);

  return {
    ...content,
    hasWelcome,
    title,
  };
}

/** 只负责展示 welcome，不包含自动展示、hash 判断或持久化策略。 */
function WelcomeDialogView({ html, isLoading = false, onClose, title }: WelcomeDialogViewProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useModalFocusTrap({
    containerRef: panelRef,
    initialFocusRef: closeButtonRef,
    onEscape: onClose,
  });

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="relative bg-bg-secondary rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col animate-in fade-in zoom-in-95 duration-200"
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-border">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-accent" />
              <h2 id={titleId} className="text-lg font-semibold text-text-primary">
                {title}
              </h2>
            </div>
            <button
              ref={closeButtonRef}
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="p-2 rounded-lg hover:bg-bg-hover transition-colors"
            >
              <X className="w-5 h-5 text-text-secondary" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {isLoading ? (
              <div className="min-h-32 flex items-center justify-center gap-2 text-text-secondary">
                <Loader2 className="w-5 h-5 animate-spin text-accent" />
                <span className="text-sm">{t('common.loading')}</span>
              </div>
            ) : (
              <div
                className="prose prose-sm max-w-none text-text-secondary"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            )}
          </div>

          {!isLoading && (
            <div className="px-6 py-4 border-t border-border">
              <button
                type="button"
                onClick={onClose}
                className="w-full px-4 py-2.5 bg-accent hover:bg-accent-hover text-white rounded-lg font-medium transition-colors"
              >
                {t('welcome.dismiss')}
              </button>
            </div>
          )}
        </div>
      </div>
    </ModalPortal>
  );
}

/** 启动时使用：内容变化才展示，关闭后记录已展示的内容 hash。 */
export function AutoWelcomeDialog() {
  const content = useWelcomeContent();
  const welcomeShownHash = useAppStore((state) => state.welcomeShownHash);
  const setWelcomeShownHash = useAppStore((state) => state.setWelcomeShownHash);

  const handleClose = useCallback(() => {
    if (content.status === 'ready') setWelcomeShownHash(content.hash);
  }, [content, setWelcomeShownHash]);

  if (!content.hasWelcome) return null;

  if (content.status === 'loading') {
    // 让 OnboardingOverlay 感知 welcome 的展示决策尚未完成，避免教程抢先弹出。
    return <div className="fixed inset-0 z-50 pointer-events-none" aria-hidden />;
  }

  if (content.status !== 'ready' || welcomeShownHash === content.hash) return null;

  return <WelcomeDialogView html={content.html} title={content.title} onClose={handleClose} />;
}

/** 用户主动查看时使用：始终展示当前解析结果，不读取或修改已展示 hash。 */
export function ManualWelcomeDialog({ onClose }: ManualWelcomeDialogProps) {
  const content = useWelcomeContent();

  useEffect(() => {
    if (content.hasWelcome && content.status === 'empty') onClose();
  }, [content.hasWelcome, content.status, onClose]);

  if (!content.hasWelcome || content.status === 'empty') return null;

  return (
    <WelcomeDialogView
      html={content.html}
      isLoading={content.status === 'loading'}
      title={content.title}
      onClose={onClose}
    />
  );
}
