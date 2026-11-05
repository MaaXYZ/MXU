import { useTranslation } from 'react-i18next';
import { Globe, Server, EthernetPort, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { isTauri, loggers } from '@/utils';
import { useAppStore } from '@/stores/appStore.ts';
import { SwitchButton } from '@/components/FormControls.tsx';
import clsx from 'clsx';

export function WebServerSection() {
  const { t } = useTranslation();
  const {
    allowLanAccess,
    setAllowLanAccess,
    webServerEnabled,
    setWebServerEnabled,
    webServerPort: configuredPort,
    setWebServerPort: setConfiguredPort,
  } = useAppStore();
  const [showRestartPrompt, setShowRestartPrompt] = useState(false);
  const [portInput, setPortInput] = useState(String(configuredPort));
  const [webServerPort, setWebServerPort] = useState<number>(0);
  const [lanIp, setLanIp] = useState<string | null>(null);

  useEffect(() => {
    setPortInput(String(configuredPort));
  }, [configuredPort]);

  useEffect(() => {
    const loadWebServerInfo = async () => {
      if (isTauri()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const [port, localIp] = await Promise.all([
            invoke<number>('get_web_server_port'),
            invoke<string | null>('get_local_lan_ip'),
          ]);
          setWebServerPort(port);
          setLanIp(localIp);
        } catch {}
      } else {
        // 浏览器环境：从当前 URL 推导端口
        const port = parseInt(window.location.port, 10);
        if (port) setWebServerPort(port);
      }
    };
    loadWebServerInfo();
  }, []);

  const webServerAddress = (() => {
    if (window.location.host && !isTauri()) {
      return window.location.origin;
    }

    // Tauri 桌面端直连后端
    if (!webServerPort) return null;

    const host = allowLanAccess ? lanIp || 'localhost' : 'localhost';
    return `http://${host}:${webServerPort}`;
  })();

  const handleLanAccessToggle = useCallback(
    (v: boolean) => {
      setAllowLanAccess(v);
      if (isTauri()) {
        setShowRestartPrompt(true);
      }
    },
    [setAllowLanAccess],
  );

  const handleWebServerToggle = useCallback(
    (v: boolean) => {
      setWebServerEnabled(v);
      if (isTauri()) {
        setShowRestartPrompt(true);
      }
    },
    [setWebServerEnabled],
  );

  const handlePortBlur = useCallback(() => {
    const parsed = parseInt(portInput, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
      setPortInput(String(configuredPort));
      return;
    }
    if (parsed !== configuredPort) {
      setConfiguredPort(parsed);
      if (isTauri()) {
        setShowRestartPrompt(true);
      }
    }
  }, [portInput, configuredPort, setConfiguredPort]);

  const handleRestart = useCallback(async () => {
    try {
      const { restartApp } = await import('@/services/updateService.ts');
      await restartApp();
    } catch (err) {
      loggers.ui.error('重启失败:', err);
    }
  }, []);

  const handleOpenWebServer = useCallback(async () => {
    if (!webServerAddress) return;
    if (isTauri()) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(webServerAddress);
    } else {
      window.open(webServerAddress, '_blank');
    }
  }, [webServerAddress]);

  return (
    <section id="section-webserver" className="space-y-4 scroll-mt-4">
      <h2 className="text-sm font-semibold text-text-primary uppercase tracking-wider flex items-center gap-2">
        <Globe className="w-4 h-4" />
        {t('webserver.title')}
      </h2>
      <div className="bg-bg-secondary rounded-xl p-4 border border-border space-y-4">
        {webServerAddress && (
          <div className="text-sm text-text-secondary space-y-1">
            <p>
              {t('webserver.address')}:{' '}
              <button
                onClick={handleOpenWebServer}
                className="inline-flex items-center gap-1 font-mono text-accent hover:text-accent/80 hover:underline transition-colors"
              >
                {webServerAddress}
                <ExternalLink className="w-3 h-3" />
              </button>
            </p>
          </div>
        )}

        {/* 启用 Web 服务器 */}
        <div
          className={clsx('flex items-center justify-between', {
            'pt-4 border-t border-border': webServerAddress,
          })}
        >
          <div className="flex items-center gap-3">
            <Server className="w-5 h-5 text-accent" />
            <div>
              <span className="font-medium text-text-primary">{t('webserver.enabled')}</span>
              <p className="text-xs text-text-muted mt-0.5">{t('webserver.enabledHint')}</p>
            </div>
          </div>
          <SwitchButton value={webServerEnabled} onChange={handleWebServerToggle} />
        </div>

        {/* Web 服务器端口 */}
        <div className="flex items-center justify-between pt-4 border-t border-border">
          <div className="flex items-center gap-3">
            <EthernetPort className="w-5 h-5 text-accent" />
            <div>
              <span className="font-medium text-text-primary">{t('webserver.port')}</span>
              <p className="text-xs text-text-muted mt-0.5">{t('webserver.portHint')}</p>
            </div>
          </div>
          <input
            type="number"
            min={1}
            max={65535}
            value={portInput}
            onChange={(e) => setPortInput(e.target.value)}
            onBlur={handlePortBlur}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            className="w-24 px-2.5 py-1.5 text-sm font-mono text-right bg-bg-tertiary border border-border rounded-lg text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        {/* 允许局域网访问 */}
        <div className="pt-4 border-t border-border space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Globe className="w-5 h-5 text-accent" />
              <div>
                <span className="font-medium text-text-primary">
                  {t('webserver.allowLanAccess')}
                </span>
                <p className="text-xs text-text-muted mt-0.5">
                  {t('webserver.allowLanAccessHint')}
                </p>
              </div>
            </div>
            <SwitchButton value={allowLanAccess} onChange={handleLanAccessToggle} />
          </div>

          {/* 重启提示 */}
          {showRestartPrompt && (
            <div className="flex items-center justify-between ml-8 p-2.5 bg-bg-tertiary rounded-lg text-sm">
              <span className="text-text-secondary">{t('webserver.restartMessage')}</span>
              <div className="flex items-center gap-2 ml-4 shrink-0">
                <button
                  onClick={() => setShowRestartPrompt(false)}
                  className="px-3 py-1 text-text-muted hover:text-text-primary rounded transition-colors"
                >
                  {t('webserver.restartLater')}
                </button>
                <button
                  onClick={handleRestart}
                  className="px-3 py-1 bg-accent text-white rounded hover:bg-accent/90 transition-colors"
                >
                  {t('webserver.restartNow')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
