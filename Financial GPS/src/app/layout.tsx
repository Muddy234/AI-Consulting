import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Financial GPS | Your Personal Money Roadmap",
  description: "A strategy-agnostic financial dashboard that translates financial advice into an interactive, step-by-step roadmap.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Roboto+Slab:wght@400;700&display=swap"
          rel="stylesheet"
        />
        <meta name="theme-color" content="#1B264F" />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
