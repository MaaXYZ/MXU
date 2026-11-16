import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { TitleBar } from '@/components';
import type { BadPathType } from '@/components';

const LazyBadPathModal = lazy(async () => {
  const module = await import('@/components/BadPathModal');
  return { default: module.BadPathModal };
});

type LoadingState = 'loading' | 'success' | 'error';

interface LoadingScreenProps {
  loadingState: LoadingState;
  errorMessage: string;
  showBadPathModal: boolean;
  badPathType: BadPathType;
  displayTitle: string;
  displaySubtitle: string;
  onRetry: () => void;
}

export function LoadingScreen({
  loadingState,
  errorMessage,
  showBadPathModal,
  badPathType,
  displayTitle,
  displaySubtitle,
  onRetry,
}: LoadingScreenProps) {
  const { t } = useTranslation();

  return (
    <div data-skin-slot="app" className="h-full flex flex-col bg-bg-primary relative">
      <TitleBar />

      {/* 程序路径问题提示模态框 - 在加载阶段也需要能弹出 */}
      {showBadPathModal && (
        <Suspense fallback={null}>
          <LazyBadPathModal show={showBadPathModal} type={badPathType} />
        </Suspense>
      )}

      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="max-w-md w-full space-y-6 text-center">
          {/* Logo/标题 */}
          <div className="space-y-2">
            <h1 className="text-3xl font-bold text-text-primary">{displayTitle}</h1>
            <p className="text-text-secondary">{displaySubtitle}</p>
          </div>

          {/* 加载状态 - 路径检查中或正常加载中 */}
          {loadingState === 'loading' && !showBadPathModal && (
            <div className="flex flex-col items-center gap-3 py-8">
              <Loader2 className="w-8 h-8 animate-spin text-accent" />
              <p className="text-text-secondary">{t('loadingScreen.loadingInterface')}</p>
            </div>
          )}

          {/* 错误状态 */}
          {loadingState === 'error' && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-center gap-2 text-red-600 dark:text-red-400">
                <AlertCircle className="w-5 h-5" />
                <span className="font-medium">{t('loadingScreen.loadFailed')}</span>
              </div>
              <p className="text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
              <button
                onClick={onRetry}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-red-100 dark:bg-red-900/30 hover:bg-red-200 dark:hover:bg-red-900/50 text-red-700 dark:text-red-300 rounded-lg transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                {t('loadingScreen.retry')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
