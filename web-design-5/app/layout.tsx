import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Five agency landing pages",
    template: "%s",
  },
  description:
    "Five distinct landing page concepts for a design and creative agency.",
};

/** Without JavaScript nothing can flag elements as revealed, so show them all. */
const noScriptReveal =
  "[data-reveal]{opacity:1!important;transform:none!important;clip-path:none!important;filter:none!important}";

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        <noscript>
          <style>{noScriptReveal}</style>
        </noscript>
        {children}
      </body>
    </html>
  );
}
