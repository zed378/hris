import { NextResponse } from 'next/server';
import { platformOverview } from '@hrms/core/platform';
import { defineAdminRoute } from '@/lib/define-admin-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineAdminRoute('GET /admin/api/overview', async () =>
  NextResponse.json(await platformOverview()),
);
