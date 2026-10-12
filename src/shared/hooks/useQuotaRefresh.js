"use client";
import { useEffect, useRef } from "react";

// Refresh only while visible; use the current callback without resetting forms.
export function useQuotaRefresh(refresh, enabled = true) {
  const callback = useRef(refresh);
  useEffect(() => { callback.current = refresh; }, [refresh]);
  useEffect(() => {
    if (!enabled) return;
    const update = () => { if (!document.hidden) callback.current(); };
    const timer = setInterval(update, 30000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
    };
  }, [enabled]);
}
