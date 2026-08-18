import { NextResponse } from 'next/server';
import { listRoles } from '@hrms/core/iam';
import { defineRoute } from '@/lib/define-route.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = defineRoute('GET /api/roles', async (_req, ctx) =>
  NextResponse.json({ roles: await listRoles(ctx.tx, ctx.tenantId) }),
);
