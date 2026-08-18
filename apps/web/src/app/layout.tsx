import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/session.tsx';
import './globals.css';

export const metadata = {
  title: 'HRMS',
  description: 'HR Management Suite',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body className="min-h-full bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
