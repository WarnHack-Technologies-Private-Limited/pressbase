import type { CSSProperties } from 'react';
import { avatarHue, initials } from '@/lib/people';
import styles from './people.module.css';

/** Initials on a tinted circle. Decorative: the name is always shown next to it. */
export function Avatar({ id, name, large }: { id: number; name: string; large?: boolean }) {
  return (
    <span
      className={[styles.avatar, large && styles.avatarLarge].filter(Boolean).join(' ')}
      style={{ '--hue': avatarHue(id) } as CSSProperties}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
