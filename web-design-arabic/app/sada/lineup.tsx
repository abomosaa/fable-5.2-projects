"use client";

import { useState } from "react";
import type { CSSProperties } from "react";

type Act = {
  time: string;
  name: string;
  genre: string;
  stage: string;
  headliner?: boolean;
};

type Day = {
  id: string;
  weekday: string;
  date: string;
  color: string;
  acts: Act[];
};

const days: Day[] = [
  {
    id: "thu",
    weekday: "الخميس",
    date: "٢٢ أبريل",
    color: "#ffd60a",
    acts: [
      { time: "١٧:٣٠", name: "ثلاثي الرصيف", genre: "جاز شرقي", stage: "مسرح النخيل" },
      { time: "١٩:٠٠", name: "نوّار", genre: "بوب بديل", stage: "مسرح الموج" },
      { time: "٢٠:٣٠", name: "فرقة الملح", genre: "روك ساحلي", stage: "مسرح الموج" },
      { time: "٢٢:٠٠", name: "ليلى والمدار", genre: "إلكترو طرب", stage: "مسرح الموج", headliner: true },
      { time: "٠٠:٠٠", name: "دي جي سراب", genre: "هاوس صحراوي", stage: "خيمة الصدى" },
    ],
  },
  {
    id: "fri",
    weekday: "الجمعة",
    date: "٢٣ أبريل",
    color: "#ff8fd0",
    acts: [
      { time: "١٧:٣٠", name: "يمام", genre: "فولك", stage: "مسرح النخيل" },
      { time: "١٩:٠٠", name: "الطابق السابع", genre: "إندي روك", stage: "مسرح الموج" },
      { time: "٢٠:٣٠", name: "سلمى بحر", genre: "سول عربي", stage: "مسرح الموج" },
      { time: "٢٢:٠٠", name: "كهرباء الجبل", genre: "دبكة سايكدليك", stage: "مسرح الموج", headliner: true },
      { time: "٠٠:٠٠", name: "مقام ٤٤٠", genre: "تكنو مقامي", stage: "خيمة الصدى" },
    ],
  },
  {
    id: "sat",
    weekday: "السبت",
    date: "٢٤ أبريل",
    color: "#7d86ff",
    acts: [
      { time: "١٧:٣٠", name: "حكواتي بيت", genre: "راب وحكاية", stage: "مسرح النخيل" },
      { time: "١٩:٠٠", name: "رمل", genre: "بوست روك", stage: "مسرح الموج" },
      { time: "٢٠:٣٠", name: "نجوم الظهيرة", genre: "فانك شعبي", stage: "مسرح الموج" },
      { time: "٢٢:٠٠", name: "أوتار المدينة", genre: "أوركسترا مستقلة", stage: "مسرح الموج", headliner: true },
      { time: "٠٠:٠٠", name: "سهرة الختام", genre: "كل منسّقي الأغاني معًا", stage: "خيمة الصدى" },
    ],
  },
];

export function Lineup() {
  const [activeId, setActiveId] = useState(days[0].id);
  const day = days.find((d) => d.id === activeId) ?? days[0];

  return (
    <div className="sd-lineup" style={{ "--day": day.color } as CSSProperties}>
      <div className="sd-tabs" role="tablist" aria-label="أيام المهرجان">
        {days.map((d) => (
          <button
            key={d.id}
            type="button"
            role="tab"
            id={`sd-tab-${d.id}`}
            aria-selected={d.id === activeId}
            aria-controls="sd-day-panel"
            style={{ "--day": d.color } as CSSProperties}
            onClick={() => setActiveId(d.id)}
          >
            <strong>{d.weekday}</strong>
            <span>{d.date}</span>
          </button>
        ))}
      </div>

      <ol
        key={day.id}
        id="sd-day-panel"
        role="tabpanel"
        aria-labelledby={`sd-tab-${day.id}`}
        className="sd-acts"
      >
        {day.acts.map((act, i) => (
          <li
            key={act.name}
            className={act.headliner ? "sd-act sd-act-head" : "sd-act"}
            style={{ "--i": i } as CSSProperties}
          >
            <span className="sd-act-time">{act.time}</span>
            <span className="sd-act-name">
              {act.name}
              {act.headliner && <em>نجم الليلة</em>}
            </span>
            <span className="sd-act-info">
              <span>{act.genre}</span>
              <b>{act.stage}</b>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
