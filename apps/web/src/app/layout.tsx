import type { ReactNode } from 'react';

export const metadata = { title: 'HRMS' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
