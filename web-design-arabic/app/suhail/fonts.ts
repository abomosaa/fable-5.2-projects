import { IBM_Plex_Mono, IBM_Plex_Sans_Arabic } from "next/font/google";

export const plexArabic = IBM_Plex_Sans_Arabic({
  weight: ["300", "400", "500", "600"],
  subsets: ["arabic", "latin"],
  variable: "--font-plex-arabic",
  display: "swap",
});

export const plexMono = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-plex-mono",
  display: "swap",
});
