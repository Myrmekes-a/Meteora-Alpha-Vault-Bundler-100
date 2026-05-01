import type { Metadata } from "next";
import "./globals.css";
import { ToastProvider } from "@/lib/toast";
import { LaunchStateProvider } from "@/lib/launchState";
import Toaster from "@/components/Toaster";

export const metadata: Metadata = {
  title: "Meteora Alpha Vault Dashboard",
  description: "Control panel for Meteora Alpha Vault Bundler",
  icons: {
    icon: "/icon",
    shortcut: "/icon",
    apple: "/icon",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-bg text-text-primary min-h-screen overflow-hidden">
        <ToastProvider>
          <LaunchStateProvider>
            {children}
            <Toaster />
          </LaunchStateProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
