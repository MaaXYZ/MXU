import { useId } from 'react';
import eating from '@/assets/skins/deepseek.png';
import calm from '@/assets/skins/deepseek-calm.png';
import type { SkinDecorSlot } from '@/skins/types';
import './deepseek.css';

/** A small porcelain bowl with a cobalt petal band around its foot. */
function RiceBowl() {
  return (
    <svg viewBox="0 0 56 41" fill="none" strokeLinejoin="round" strokeLinecap="round">
      <g stroke="#445d8b" strokeWidth="1.5">
        <path
          fill="#fffdf5"
          d="M7 22c0-4 2-7 5-7 1-4 4-6 8-5 2-4 6-5 9-2 4-3 8-2 10 2 4-1 7 2 7 6 3 0 5 3 5 6z"
        />
        <path stroke="#d3c4aa" d="m14 15 2 1m5-4 2 2m8-3 2 1m2 4 2-1m6 1 1 2m-15-2 2 1" />
        <path fill="#abc8ee" d="m21 33-1 3c2 3 14 4 17 0l-1-3" />
        <path fill="#fffdf4" d="M5 20q21 5 47 0c-2 11-11 15-22 15S8 31 5 20Z" />
        <path
          fill="#5082b9"
          stroke="none"
          d="M12 25q2 5 8 6-1-4-8-6m9 1q0 5 5 6 1-4-5-6m9 6q6-1 6-7-6 3-6 7m8-2q6-2 9-7-7 2-9 7"
        />
        <path stroke="#5986b6" d="M7 23q20 5 43 0" />
      </g>
    </svg>
  );
}

function Ribbon() {
  return (
    <svg viewBox="0 0 65 43" fill="none" stroke="#365481" strokeWidth="1.6" strokeLinejoin="round">
      <path
        fill="#7099ca"
        d="M29 22c-1 5-7 12-11 14l7-1 3 4c4-7 6-12 6-17m1 0c1 6 6 13 11 15l-1-6 6 1c-5-4-8-7-11-13"
      />
      <path
        fill="#99bcea"
        d="M31 19C21 8 10 4 8 7c-3 4-3 17 0 23 3 3 17-4 24-8m3-3C43 10 55 5 57 9c3 6 3 14 0 20-4 3-16-3-22-7"
      />
      <path stroke="#f4f8ff" strokeWidth="2.7" d="M10 9c-1 3-2 12-1 16m45-13c2 3 2 9 1 13" />
      <path stroke="#5a7caa" d="m16 15 13 6-11 2m29-7-9 5 10 1" />
      <path fill="#668bb9" d="M29 17q4-2 7 0l1 7q-5 2-8 0z" />
    </svg>
  );
}

function RiceMat() {
  const check = useId();
  return (
    <svg className="rice-mat" viewBox="0 0 320 104" fill="none">
      <defs>
        <pattern
          id={check}
          width="18"
          height="14"
          patternUnits="userSpaceOnUse"
          patternTransform="matrix(1 -.13 .65 .72 0 0)"
        >
          <rect width="18" height="14" fill="#fcf8ed" />
          <path d="M3 0v14M0 4h18" stroke="#9dbce1" strokeWidth="6" opacity=".62" />
          <path d="M7 0v14M0 8h18" stroke="#779bc9" strokeWidth=".8" opacity=".7" />
        </pattern>
      </defs>
      <g strokeLinejoin="round" strokeLinecap="round">
        <path
          fill="#5577a5"
          opacity=".16"
          d="m15 61 181-37q5-1 11 1l99 47q4 3-1 6l-181 25q-7 1-13-2z"
        />
        <path
          d="m11 55 182-36q8-2 15 2l98 46q4 2-1 4l-179 27q-8 1-14-2L10 60q-4-2 1-5Z"
          fill={`url(#${check})`}
          stroke="#819cc0"
          strokeWidth="1.4"
        />
        <path
          d="m19 58 176-34q7-1 13 2l87 42-171 25q-6 0-11-2Z"
          stroke="#6583aa"
          strokeWidth="1.1"
          strokeDasharray="2 4"
        />
        <path fill="#bdcfe5" d="m270 77 34-9-12-7-3 7z" />
        <g stroke="#504867" strokeWidth="1.5">
          <path fill="#82644e" d="m204 79 91-37q3-1 4 2 1 2-2 3l-92 34z" />
          <path fill="#ac8460" d="m203 84 96-27q3-1 4 2 0 2-2 3l-97 24z" />
        </g>
        <path d="m282 48 1 3m3-5 1 3m4 10 1 3m3-4 1 3" stroke="#f6dfa9" strokeWidth="1.6" />
      </g>
    </svg>
  );
}

export function DeepseekDecor({ slot }: { slot: SkinDecorSlot }) {
  if (slot === 'logs') {
    return (
      <span className="skin-decor--logs rice-log-bowl" aria-hidden="true">
        <RiceBowl />
      </span>
    );
  }

  if (slot === 'screenshot') {
    return (
      <span className="skin-decor--screenshot rice-photo" aria-hidden="true">
        <img src={calm} alt="" draggable={false} />
        <span className="rice-photo__ribbon">
          <Ribbon />
        </span>
      </span>
    );
  }

  return (
    <div className="skin-decor--tasks rice-place-setting" aria-hidden="true">
      <div className="rice-place-setting__art">
        <RiceMat />
        <img className="rice-guest" src={eating} alt="" draggable={false} />
        <span className="rice-grains">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}
