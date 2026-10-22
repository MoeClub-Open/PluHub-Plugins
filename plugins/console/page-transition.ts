import React from "react";

/** Animate navigation after an asynchronously mounted extension has rendered. */
export function usePageTransition(
  path: string,
  enabled: boolean,
  content: React.RefObject<HTMLElement | null>,
  extension: React.RefObject<HTMLElement | null>,
) {
  React.useLayoutEffect(() => {
    const element = content.current;
    if (!enabled || !element) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animation: Animation | undefined;
    let observer: MutationObserver | undefined;
    const enter = () => {
      observer?.disconnect();
      if (motion.matches) return;
      animation = element.animate(
        [
          { opacity: 0, transform: "translateY(4px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        { duration: 160, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
    };
    if (extension.current) {
      observer = new MutationObserver((changes) => {
        if (changes.some((change) => change.addedNodes.length)) enter();
      });
      observer.observe(extension.current, { childList: true });
    } else enter();
    const preferenceChanged = () => {
      if (motion.matches) animation?.cancel();
    };
    motion.addEventListener("change", preferenceChanged);
    return () => {
      observer?.disconnect();
      animation?.cancel();
      motion.removeEventListener("change", preferenceChanged);
    };
  }, [path, enabled]);
}
