import clutch from '@/assets/skins/naiwa-clutch.webp';
import grin from '@/assets/skins/naiwa-grin.webp';
import roll from '@/assets/skins/naiwa-roll.webp';
import type { SkinDecorSlot } from '@/skins/types';
import './naiwa.css';

export function NaiwaDecor({ slot }: { slot: SkinDecorSlot }) {
  if (slot === 'logs') {
    return (
      <svg
        className="skin-decor--logs naiwa-laugh-marks"
        viewBox="0 0 25 21"
        aria-hidden="true"
        focusable="false"
      >
        <path d="M3 13Q5 8 4 4Q8 2 9 5Q9 8 5 14Z" />
        <path d="M9 14Q14 9 16 5Q21 4 20 8Q17 12 11 16Z" />
        <path d="M13 18Q18 16 22 13Q25 14 23 17Q19 19 14 20Z" />
      </svg>
    );
  }

  if (slot === 'screenshot') {
    return (
      <span className="skin-decor--screenshot naiwa-outtake" aria-hidden="true">
        <img src={roll} alt="" draggable={false} />
      </span>
    );
  }

  return (
    <div className="skin-decor--tasks naiwa-reel" aria-hidden="true">
      <svg
        className="naiwa-reel__art"
        viewBox="0 0 282 184"
        preserveAspectRatio="xMaxYMax meet"
        focusable="false"
      >
        <ellipse className="naiwa-reel__shadow" cx="175" cy="173" rx="91" ry="6" />
        <g transform="rotate(-8 75 130)">
          <rect className="naiwa-reel__stock" x="9" y="104" width="123" height="63" rx="4" />
          <path className="naiwa-reel__holes" d="M15 109h113M15 162h113" />
          <g className="naiwa-reel__frames">
            <rect x="14" y="114" width="55" height="43" rx="2" />
            <rect x="73" y="114" width="54" height="43" rx="2" />
          </g>
          <image href={clutch} x="25" y="115" width="31" height="41" />
          <image href={roll} x="76" y="120" width="47" height="35" />
        </g>
        <image className="naiwa-reel__hero" href={grin} x="135" y="4" width="95" height="171" />
        <g className="naiwa-reel__rattle">
          <path d="M136 66q-8 8-8 19m2-26q-9 8-11 17M234 61q5 7 4 14m2-19q6 7 6 13" />
          <path d="M207 17q6-2 10-8m-5 17q8-1 14-6" />
        </g>
      </svg>
    </div>
  );
}
