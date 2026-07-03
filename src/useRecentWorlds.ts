import { useState } from "react";
import type { RecentWorld } from "./types";

const RECENT_WORLDS_KEY = "eden_recent_worlds";
const MAX_RECENT = 8;

/** Formats a timestamp as a short relative-time label ("3m ago", "2w ago", ...). */
export function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  if (d < 31) return `${Math.floor(d / 7)}w ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** localStorage-backed MRU list of opened worlds, capped at MAX_RECENT entries. */
export function useRecentWorlds() {
  const [recentWorlds, setRecentWorlds] = useState<RecentWorld[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_WORLDS_KEY) ?? "[]"); }
    catch { return []; }
  });

  function addRecentWorld(path: string, name: string) {
    setRecentWorlds(prev => {
      const next = [{ path, name, timestamp: Date.now() }, ...prev.filter(r => r.path !== path)].slice(0, MAX_RECENT);
      try { localStorage.setItem(RECENT_WORLDS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  return { recentWorlds, addRecentWorld };
}
