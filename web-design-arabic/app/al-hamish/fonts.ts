import { Amiri, Noto_Naskh_Arabic } from "next/font/google";

export const amiri = Amiri({
  weight: ["400", "700"],
  style: ["normal", "italic"],
  subsets: ["arabic"],
  variable: "--font-amiri",
  display: "swap",
});

export const naskh = Noto_Naskh_Arabic({
  subsets: ["arabic"],
  variable: "--font-naskh",
  display: "swap",
});
