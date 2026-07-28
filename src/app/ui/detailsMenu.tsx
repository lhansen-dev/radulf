"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A wrapper around `<details>` that closes when the user clicks outside
 * the element or presses Escape.
 *
 * Props:
 * - `detailsClassName` – className for the outer `<details>`
 * - `summaryClassName` – className for the `<summary>`
 * - `menuClassName`    – className for the inner `<div>` that holds menu items
 * - `ariaLabel`        – aria-label for the `<summary>`
 * - `summary`          – children of the `<summary>` (e.g. "•••")
 * - `children`         – the menu content rendered inside the `<div>`
 */
export function DetailsMenu({
  detailsClassName,
  summaryClassName,
  menuClassName,
  ariaLabel,
  summary,
  children,
}: {
  detailsClassName?: string;
  summaryClassName?: string;
  menuClassName?: string;
  ariaLabel: string;
  summary: ReactNode;
  children: ReactNode;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const details = detailsRef.current;
    if (!details) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!details.open) return;
      // If the click target is not inside the details element, close it
      if (details.contains(event.target as Node)) return;
      details.open = false;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!details.open) return;
      if (event.key === "Escape") {
        details.open = false;
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <details ref={detailsRef} className={detailsClassName}>
      <summary
        className={summaryClassName}
        aria-label={ariaLabel}
      >
        {summary}
      </summary>
      <div className={menuClassName}>{children}</div>
    </details>
  );
}