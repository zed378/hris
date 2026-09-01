/**
 * Email templates.
 *
 * Plain text, not HTML. Three reasons, and the third is decisive:
 * plain text filters better through spam filters, reads in any email client, and
 * cannot hide a link behind different-looking text — which is precisely the hallmark
 * of phishing emails that impersonate HR notifications.
 *
 * The tone is deliberately flat and specific. HR emails that sound like marketing
 * material get skimmed; those that mention a name, a date, and one concrete action
 * get read.
 */

function appUrl(path: string): string {
  const base = (process.env['APP_BASE_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}${path}`;
}

export interface RenderedEmail {
  subject: string;
  text: string;
}

export function passwordResetEmail(input: {
  tenantName: string;
  fullName: string;
  token: string;
  expiresAt: string;
}): RenderedEmail {
  const expires = formatDateTime(input.expiresAt);

  return {
    subject: `Password reset — ${input.tenantName}`,
    text: [
      `Hello ${input.fullName},`,
      '',
      `We received a request to reset the password for your account on ${input.tenantName}.`,
      '',
      'Open the following link to set a new password:',
      appUrl(`/reset-password?token=${input.token}`),
      '',
      `This link is valid until ${expires} and can be used only once.`,
      '',
      // This is the line that makes a password reset email useful as a security
      // signal: the recipient who did not request it now knows someone is trying.
      'If you did not make this request, ignore this email — your password has not changed.',
      'However, if this repeats, alert your company\'s HR department.',
      '',
      'After the password is changed, all your sessions on other devices will end.',
    ].join('\n'),
  };
}

export function invitationEmail(input: {
  tenantName: string;
  tenantCode: string;
  fullName: string;
  token: string;
  expiresAt: string;
}): RenderedEmail {
  return {
    subject: `Join invitation — ${input.tenantName}`,
    text: [
      `Hello ${input.fullName},`,
      '',
      `You have been invited to access the HR system for ${input.tenantName}.`,
      '',
      'Open the following link to set your password:',
      appUrl(`/accept-invitation?token=${input.token}`),
      '',
      `This link is valid until ${formatDateTime(input.expiresAt)}.`,
      '',
      'When you sign in later, you will need three things:',
      `  Company code  : ${input.tenantCode}`,
      '  Email         : this email address',
      '  Password      : that you set via the link above',
      '',
      // The company code is what most people get wrong on the first login attempt.
      // Stating it here saves one support ticket per new user.
      'Save that company code — it is needed every time you sign in.',
    ].join('\n'),
  };
}

/**
 * The actual remaining days, not the threshold label.
 *
 * A D7 threshold catches contracts with 0 to 7 days left. Writing "expires in
 * 7 days" for a contract with 5 days left makes HR plan two days late — and on
 * modules whose every value is about communicating the right deadline, that is
 * not a minor inaccuracy.
 */
function remainingText(daysLeft: number): string {
  if (daysLeft < 0) return 'EXPIRED';
  if (daysLeft === 0) return 'expires TODAY';
  if (daysLeft === 1) return 'expires TOMORROW';
  return `expires in ${daysLeft} days`;
}

export function contractExpiringEmail(input: {
  tenantName: string;
  employeeName: string;
  employeeNumber: string;
  contractNumber: string;
  contractType: string;
  endDate: string;
  daysLeft: number;
  threshold: string;
}): RenderedEmail {
  const expired = input.threshold === 'EXPIRED';

  const subject = expired
    ? `ACTION REQUIRED: contract for ${input.employeeName} has expired`
    : `Contract for ${input.employeeName} ${remainingText(input.daysLeft)}`;

  const body = [
    `The following employment contract ${remainingText(input.daysLeft)}:`,
    '',
    `  Employee        : ${input.employeeName} (${input.employeeNumber})`,
    `  Contract number : ${input.contractNumber}`,
    `  Type            : ${input.contractType}`,
    `  Expiry date     : ${formatDate(input.endDate)}`,
    '',
  ];

  if (expired) {
    // This warning is what makes the module worthwhile. A PKWT that is left
    // expired does not merely "need renewal" — its legal status changes, and
    // that change is irreversible.
    body.push(
      `This contract expired ${Math.abs(input.daysLeft)} days ago and has not been actioned.`,
      '',
      'A PKWT left expired without renewal or formal closure may be deemed converted',
      'to a permanent employee (PKWTT) by law. This conversion is irreversible.',
      'Contact your legal department or senior HR immediately.',
    );
  } else {
    body.push(
      'Action required: renew, convert to permanent employee, or close according',
      'to the terms. A decision must be made before the date above.',
    );
  }

  body.push('', 'See contracts expiring soon:', appUrl('/employees/contracts'));

  return { subject, text: [`Hello,`, '', ...body].join('\n') };
}

/**
 * Reminder for documents about to expire.
 *
 * Its content varies by document type, and that is what makes this email
 * valuable. "KITAS document will expire" cannot be actioned by anyone reading it
 * while walking past; "foreign workers working without a permit is a criminal
 * offence against the company" can.
 */
export function documentExpiringEmail(input: {
  tenantName: string;
  employeeName: string;
  employeeNumber: string;
  kind: string;
  title: string;
  expiresAt: string;
  daysLeft: number;
  threshold: string;
}): RenderedEmail {
  const expired = input.threshold === 'EXPIRED';

  const subject = expired
    ? `ACTION REQUIRED: ${input.kind} for ${input.employeeName} has expired`
    : `${input.kind} for ${input.employeeName} ${remainingText(input.daysLeft)}`;

  const body = [
    `The following document ${remainingText(input.daysLeft)}:`,
    '',
    `  Employee        : ${input.employeeName} (${input.employeeNumber})`,
    `  Document type   : ${input.kind}`,
    `  Title           : ${input.title}`,
    `  Expires         : ${formatDate(input.expiresAt)}`,
    '',
  ];

  const konsekuensi = consequenceText(input.kind);
  if (konsekuensi) body.push(konsekuensi, '');

  if (expired) {
    body.push(
      `This document expired ${Math.abs(input.daysLeft)} days ago and has not been updated.`,
    );
  } else {
    body.push('Renewal should start now — some permits take weeks to process.');
  }

  body.push('', 'See employee documents:', appUrl('/employees/documents'));

  return { subject, text: [`Hello,`, '', ...body].join('\n') };
}

/**
 * The consequence of letting this document expire.
 *
 * Only for types whose consequence is concrete and can be stated without guessing.
 * Other types get no sentence — a warning fabricated for every type only makes
 * the real ones ignored.
 */
function consequenceText(kind: string): string | null {
  switch (kind.toUpperCase()) {
    case 'KITAS':
    case 'IMTA':
      return (
        'An expired KITAS/IMTA means a foreign worker is working without a permit.\n' +
        'Under Indonesian Immigration Law No. 6/2011, this is a criminal offence\n' +
        'against the company and may result in deportation for the individual.'
      );
    case 'SIM':
      return (
        'An expired driver\'s licence means driving without a permit. Vehicle insurance\n' +
        'claims can be denied on the first accident, and liability falls to the company.'
      );
    case 'SERTIFIKAT':
      return (
        'An expired competency certificate can invalidate eligibility for\n' +
        'work that requires it.'
      );
    default:
      return null;
  }
}

function formatDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-');
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${Number(day)} ${months[Number(month) - 1]} ${year}`;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return `${formatDate(iso)} pukul ${String(date.getUTCHours()).padStart(2, '0')}:${String(
    date.getUTCMinutes(),
  ).padStart(2, '0')} UTC`;
}
