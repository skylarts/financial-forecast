import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { SideNav } from "@/components/layout/SideNav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Forecast",
  description: "Household net-worth forecasting.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* The side nav is a peer of the page, not part of it, so both tools
          share one rail and neither has to render its own. */}
      <body className="min-h-full flex">
        <AuthProvider>
          <SideNav />
          <div className="flex min-w-0 flex-1 flex-col">{children}</div>
        </AuthProvider>
      </body>
    </html>
  );
}
