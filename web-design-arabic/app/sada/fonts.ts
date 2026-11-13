import { Alexandria, Handjet } from "next/font/google";

export const alexandria = Alexandria({
  subsets: ["arabic"],
  variable: "--font-alexandria",
  display: "swap",
});

export const handjet = Handjet({
  subsets: ["arabic"],
  variable: "--font-handjet",
  display: "swap",
});
