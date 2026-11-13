import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "ثلاثة تصاميم عربية",
    template: "%s · ثلاثة تصاميم عربية",
  },
  description:
    "ثلاثة مواقع عربية بثلاث لغات بصرية مختلفة: مجلة أدبية، ومرصد فلكي، ومهرجان موسيقي.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
