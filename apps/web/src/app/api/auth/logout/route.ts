import { NextResponse } from 'next/server';
import { refreshRequestSchema } from '@hrms/contracts';
import { logout } from '@hrms/core/auth';
import { definePublicRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = definePublicRoute('POST /api/auth/logout', async (req) => {
  const parsed = refreshRequestSchema.safeParse(await req.json().catch(() => null));

  // Selalu 204, termasuk untuk token yang tidak dikenal. Logout bukan tempat
  // untuk memberi tahu pemanggil apakah sebuah token pernah ada.
  if (parsed.success) await logout(parsed.data.refreshToken);
  return new NextResponse(null, { status: 204 });
});
