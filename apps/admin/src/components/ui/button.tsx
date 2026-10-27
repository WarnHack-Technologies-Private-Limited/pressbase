import Link from 'next/link';
import type { ButtonHTMLAttributes, ComponentProps, ReactNode, Ref } from 'react';
import styles from './button.module.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

interface StyleProps {
  variant?: Variant;
  size?: 'md' | 'sm';
  fullWidth?: boolean;
  icon?: ReactNode;
}

function classes({ variant = 'secondary', size = 'md', fullWidth }: StyleProps, extra?: string) {
  return [
    styles.button,
    styles[variant],
    size === 'sm' && styles.sm,
    fullWidth && styles.full,
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

export function Spinner() {
  return <span className={styles.spinner} aria-hidden="true" />;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, StyleProps {
  /** Shows a spinner and blocks clicks while keeping the label readable. */
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant,
  size,
  fullWidth,
  icon,
  loading,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={classes({ variant, size, fullWidth }, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

export function ButtonLink({
  variant,
  size,
  fullWidth,
  icon,
  className,
  children,
  ...rest
}: ComponentProps<typeof Link> & StyleProps) {
  return (
    <Link className={classes({ variant, size, fullWidth }, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
