'use client';

import Link, { type LinkProps } from 'next/link';
import { useRouter } from 'next/navigation';
import { forwardRef, startTransition, type AnchorHTMLAttributes, type MouseEvent } from 'react';

type Direction = 'forward' | 'back';
type AuthLinkProps = LinkProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps> & {
    direction?: Direction;
  };

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => unknown;
};

/**
 * Keeps navigation between auth pages visually continuous. The browser View
 * Transitions API morphs the shared card snapshot; browsers without it still
 * get the regular Next.js navigation and the CSS entry animation.
 */
export const AuthLink = forwardRef<HTMLAnchorElement, AuthLinkProps>(function AuthLink(
  { direction = 'forward', onClick, href, ...props },
  ref,
) {
  const router = useRouter();

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;

    event.preventDefault();
    document.documentElement.dataset.authDirection = direction;
    const navigate = () => startTransition(() => router.push(String(href)));
    const transitionDocument = document as ViewTransitionDocument;
    if (transitionDocument.startViewTransition) transitionDocument.startViewTransition(navigate);
    else navigate();
  }

  return <Link ref={ref} href={href} onClick={handleClick} {...props} />;
});
