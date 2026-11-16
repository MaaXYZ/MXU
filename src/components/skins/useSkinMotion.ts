import { useEffect, useState } from 'react';

/** System policy and document visibility apply to every built-in scene layer. */
export function useSkinMotion() {
  const [systemReduced, setSystemReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || !document.hidden,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => setSystemReduced(media.matches);
    const updateVisibility = () => setPageVisible(!document.hidden);
    const hide = () => setPageVisible(false);
    updateMotion();
    media.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateVisibility);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', updateVisibility);
    return () => {
      media.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', updateVisibility);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', updateVisibility);
    };
  }, []);
  return { systemReduced, pageVisible };
}
