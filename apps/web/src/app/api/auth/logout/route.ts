import { NextResponse } from 'next/server';
import { logout } from '@hrms/core/auth';
import { definePublicRoute } from '@/lib/define-route.ts';
import { readRefreshCookie, clearRefreshCookie } from '@/lib/session-cookie.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = definePublicRoute('POST /api/auth/logout', async (req) => {
  const token = readRefreshCookie(req);

  // Selalu 204, termasuk untuk sesi yang tidak dikenal. Logout bukan tempat
  // untuk memberi tahu pemanggil apakah sebuah sesi pernah ada.
  if (token) await logout(token);

  const response = new NextResponse(null, { status: 204 });
  clearRefreshCookie(response);
  return response;
});
