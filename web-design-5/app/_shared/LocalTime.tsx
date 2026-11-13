"use client";

import { useSyncExternalStore } from "react";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, seconds: boolean) {
  const key = `${timeZone}:${seconds}`;
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: seconds ? "2-digit" : undefined,
      hour12: false,
    });
    formatters.set(key, fmt);
  }
  return fmt;
}

function subscribe(onTick: () => void) {
  const id = window.setInterval(onTick, 1000);
  return () => window.clearInterval(id);
}

type LocalTimeProps = {
  /** IANA time zone, e.g. `Europe/Zurich`. */
  timeZone: string;
  seconds?: boolean;
  className?: string;
};

/** A live studio clock. Renders a neutral placeholder on the server. */
export function LocalTime({
  timeZone,
  seconds = true,
  className,
}: LocalTimeProps) {
  const placeholder = seconds ? "--:--:--" : "--:--";
  const time = useSyncExternalStore(
    subscribe,
    () => formatter(timeZone, seconds).format(new Date()),
    () => placeholder,
  );

  return (
    <time className={className} suppressHydrationWarning>
      {time}
    </time>
  );
}
