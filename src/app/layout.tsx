import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fairway — Rank Your Golf Courses",
  description: "Force-rank the golf courses you've played and discover your true favorites.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Fairway",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#1a3a2a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="apple-touch-icon" href="/icon-192.svg" />
        {/* Inline script to prevent theme FOUC — runs before first paint */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})();if("serviceWorker"in navigator)navigator.serviceWorker.register("/sw.js")`,
          }}
        />
      </head>
      <body className="font-sans antialiased md:bg-muted/30">
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
