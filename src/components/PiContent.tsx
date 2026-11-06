import { useEffect, useState, type ReactNode } from 'react';
import { useAppStore } from '@/stores/appStore';
import { getInterfaceLangKey } from '@/i18n';
import { loadIconAsDataUrl, useResolvedContent } from '@/services/contentResolver';

export function PiIcon({
  icon,
  fallback = null,
  className = 'h-4 w-4 shrink-0 object-contain',
  basePath: customBasePath,
}: {
  icon?: string;
  fallback?: ReactNode;
  className?: string;
  basePath?: string;
}) {
  const storedBasePath = useAppStore((state) => state.basePath);
  const basePath = customBasePath ?? storedBasePath;
  const language = useAppStore((state) => state.language);
  const interfaceTranslations = useAppStore((state) => state.interfaceTranslations);
  const translations = interfaceTranslations[getInterfaceLangKey(language)];
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let active = true;
    setUrl(undefined);
    if (icon)
      void loadIconAsDataUrl(icon, basePath, translations)
        .then((url) => {
          if (active) setUrl(url);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [icon, basePath, translations]);
  return url ? <img src={url} alt="" className={className} /> : fallback;
}

export function PiDescription({
  source,
  className = 'text-xs text-text-secondary',
}: {
  source?: string;
  className?: string;
}) {
  const basePath = useAppStore((state) => state.basePath);
  const language = useAppStore((state) => state.language);
  const interfaceTranslations = useAppStore((state) => state.interfaceTranslations);
  const resolved = useResolvedContent(
    source,
    basePath,
    interfaceTranslations[getInterfaceLangKey(language)],
  );
  return resolved.html ? (
    <div
      className={`${className} [&_p]:my-0.5 [&_a]:text-accent`}
      dangerouslySetInnerHTML={{ __html: resolved.html }}
    />
  ) : null;
}
