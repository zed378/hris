import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/session.tsx';
import { ServiceWorker } from '@/components/service-worker.tsx';
import './globals.css';

export const metadata = {
  title: 'HRMS',
  description: 'HR Management Suite',
  manifest: '/manifest.webmanifest',
};

export const viewport = {
  themeColor: '#2f5fd0',
  // Zoom TIDAK dikunci. Aplikasi HR dipakai orang dengan penglihatan yang
  // beragam, dan `maximum-scale=1` adalah salah satu cara termudah membuat
  // aplikasi tidak dapat dipakai sebagian penggunanya.
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body className="min-h-full bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <SessionProvider>{children}</SessionProvider>
        <ServiceWorker />
      </body>
    </html>
  );
}
