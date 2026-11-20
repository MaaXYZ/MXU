import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import type { BuiltinSkinId } from '@/skins/types';
import deepseekArt from '@/assets/skins/deepseek.png';
import deepseekCalm from '@/assets/skins/deepseek-calm.png';
import deepseekClip from '@/assets/skins/deepseek-eat.mp4';
import naiwaCalm from '@/assets/skins/naiwa-calm.png';
import naiwaStill from '@/assets/skins/naiwa-still.webp';
import naiwaClip from '@/assets/skins/naiwa-laugh.mp4';
import gugugagaIdle from '@/assets/skins/gugugaga-idle.webp';
import gugugagaCheer from '@/assets/skins/gugugaga-cheer.webp';
import { useSkinMotion } from './useSkinMotion';
import './skins.css';

const INTERACTION_MS = 2400;

const SKIN_LABEL_KEYS = {
  deepseek: 'settings.skinDeepseek',
  naiwa: 'settings.skinNaiwa',
  gugugaga: 'settings.skinGugugaga',
} as const;

const SKIN_SCENE_KEYS = {
  deepseek: 'skin.deepseekScene',
  naiwa: 'skin.naiwaScene',
  gugugaga: 'skin.gugugagaScene',
} as const;

/** The appearance settings preview the bundled character and its interaction. */
export function BuiltinSkinCompanion() {
  const skinId = useAppStore((state) => state.skinId);
  if (skinId === 'default') return null;
  return <CompanionPreview key={skinId} skinId={skinId} />;
}

function CompanionPreview({ skinId }: { skinId: Exclude<BuiltinSkinId, 'default'> }) {
  const { t } = useTranslation();
  const userReduced = useAppStore((state) => state.skinReducedMotion);
  const { systemReduced, pageVisible } = useSkinMotion();
  const reduced = userReduced || systemReduced;
  const [interacting, setInteracting] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interactionRevision = useRef(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackRevision = useRef(0);
  const wantsPlayback = useRef(false);
  const clip = skinId === 'naiwa' ? naiwaClip : skinId === 'deepseek' ? deepseekClip : null;
  const performing = interacting && !!clip && !reduced && pageVisible && !videoFailed;
  wantsPlayback.current = performing;

  // Leaving the preview or hiding the page ends the interaction.
  useEffect(() => {
    setInteracting(false);
    return () => {
      interactionRevision.current++;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [pageVisible]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const revision = ++playbackRevision.current;
    video.muted = true;
    video.defaultMuted = true;
    if (performing) {
      try {
        const result = video.play();
        result?.then(
          () => {
            if (
              !video.isConnected ||
              (revision !== playbackRevision.current && !wantsPlayback.current)
            )
              video.pause();
          },
          () => {
            if (revision === playbackRevision.current) setVideoFailed(true);
          },
        );
      } catch {
        setVideoFailed(true);
      }
    } else {
      video.pause();
      video.currentTime = 0;
    }
    return () => {
      playbackRevision.current++;
      video.pause();
    };
  }, [performing, pageVisible]);

  function interact() {
    if (timer.current !== null) clearTimeout(timer.current);
    const revision = ++interactionRevision.current;
    setInteracting(true);
    timer.current = setTimeout(() => {
      if (revision !== interactionRevision.current) return;
      timer.current = null;
      setInteracting(false);
    }, INTERACTION_MS);
  }

  const pose =
    skinId === 'deepseek'
      ? interacting
        ? deepseekArt
        : deepseekCalm
      : skinId === 'naiwa'
        ? interacting
          ? naiwaStill
          : naiwaCalm
        : interacting
          ? gugugagaCheer
          : gugugagaIdle;

  return (
    <section
      className={`builtin-skin builtin-skin--${skinId}`}
      aria-label={t('skin.regionLabel')}
      data-builtin-skin={skinId}
      data-task-state="idle"
      data-reduced-motion={reduced}
      data-scene-motion={!pageVisible ? 'paused' : reduced ? 'reduced' : 'full'}
      data-interacting={interacting}
      data-performing={performing}
    >
      <div className="builtin-skin__copy">
        <div className="builtin-skin__eyebrow">{t(SKIN_LABEL_KEYS[skinId])}</div>
        <h2>{t(SKIN_SCENE_KEYS[skinId])}</h2>
        <span>{t('skin.state.idle')}</span>
        {reduced && <small>{t('skin.reducedMotion')}</small>}
      </div>
      <div className="builtin-skin__stage">
        <span className="builtin-skin__plinth" aria-hidden="true" />
        <div className={`builtin-skin__art builtin-skin__art--${skinId}`} aria-hidden="true">
          <img src={pose} alt="" draggable={false} />
          {clip && (
            <video
              ref={videoRef}
              src={clip}
              poster={skinId === 'naiwa' ? naiwaStill : deepseekArt}
              className={performing ? 'builtin-skin__video is-playing' : 'builtin-skin__video'}
              muted
              loop
              playsInline
              preload="metadata"
              onError={() => setVideoFailed(true)}
            />
          )}
        </div>
      </div>
      <button
        type="button"
        className="builtin-skin__interact"
        onClick={interact}
        aria-pressed={interacting}
      >
        <span aria-hidden="true">{skinId === 'deepseek' ? '+' : '▷'}</span>
        {t(skinId === 'deepseek' ? 'skin.feed' : skinId === 'naiwa' ? 'skin.poke' : 'skin.cheer')}
      </button>
    </section>
  );
}
