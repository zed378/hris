# 12 — Form UX

How forms collect input: layout, validation, errors, and the specific inputs this product needs (Indonesian identifiers, money, dates, files). Forms are built with native inputs and inline Tailwind classes; the server validates every body with `zod` (`../PLAN/15-API-CONTRACT.md` §6).

---

## 1. Principles

1. **The server is the validator of record.** Client-side checks exist to save a round trip, never as the only check. A form that passes client checks and fails on the server must show the server's field errors in the same place.
2. **One column on phones, grouped on desktop.** Related fields side by side above `sm` (e.g. start and end date); never unrelated fields.
3. **Labels above inputs, always visible.** Placeholders show a format example ("3201…"), never replace the label.
4. **Ask only what is needed now.** Registration asks for the company and the owner; everything else is set up later.
5. **Keep the user's input on failure.** Nothing is cleared by an error.

## 2. Anatomy of a Field

```
Label                         (text-sm font-medium)
[ input                    ]  (mt-1 w-full rounded-md border px-3 py-2)
Hint or format example        (text-xs text-slate-500)          — optional
Error message                 (text-xs text-red-700, role via aria-describedby) — when invalid
```

| Attribute | Rule | Today |
|---|---|---|
| Label association | `<label>` wrapping the input, or `htmlFor` + `id` | Wrapping (43) — correct |
| `required` | On every field the schema requires; plus "(wajib)" in the label for clarity | 3 uses |
| `aria-invalid` | `true` when the field has an error | None |
| `aria-describedby` | Points to the hint and the error | None |
| `autoComplete` | `email`, `current-password`, `new-password`, `name`, `organization`, `tel` | 12 uses — good on auth forms |
| `inputMode` | `numeric` for IDs and amounts; `decimal` for coordinates and rates | 1 use |
| `type` | `email`, `password`, `date`, `time`, `number` only for true quantities (never for identifiers — leading zeros vanish) | `date` 12 |

## 3. Validation Timing

| When | What |
|---|---|
| While typing | Nothing. Do not flash errors at a half-typed value |
| On blur | Format checks only (length of an NIK, email shape) |
| On submit | All client checks; focus moves to the first invalid field; a summary at the top lists the errors for long forms |
| On server response | `400 VALIDATION_FAILED` → map `details` onto fields by key; anything unmapped goes into the summary |

**Today:** server field errors are mapped onto fields on 2 pages (`/register`, `/attendance/sites`). Everywhere else a validation failure shows as one error line. The `Field` component (`06-COMPONENT-SPECIFICATION.md`) should make field mapping the default.

## 4. Submission

- The submit button is disabled and relabelled while in flight ("Menyimpan…"). Double submission is also prevented server-side where it matters (punch `dedupeKey`, payroll run uniqueness).
- `Enter` submits single-purpose forms.
- On success: either stay and show a `role="status"` confirmation, or navigate to the result — never both silently.
- On failure: `12` §3 and `11-EMPTY-LOADING-ERROR-STATES.md` §4.

## 5. Inputs Specific to This Product

| Input | Rule |
|---|---|
| **NIK** (national ID) | 16 digits. `inputMode="numeric"`, text type (never `number`). Masked on display unless the viewer holds `employee.pii.unmask`; the edit form never pre-fills a masked value as if it were real |
| **NPWP** (tax ID) | Accept with or without punctuation; store normalised. Masked like NIK |
| **Bank account** | Digits; masked like NIK |
| **Money (Rupiah)** | `inputMode="numeric"`; display with `Intl.NumberFormat('id-ID')` (thousands separator `.`); no decimals for Rupiah amounts; store as integer |
| **Percentages and rates** | `inputMode="decimal"`; accept `,` as the decimal separator as Indonesian users type it |
| **Dates** | Native `type="date"`. Display format `13 September 2026` or `13/09/2026`, never `09/13` |
| **Times and shifts** | `HH.mm` display (Indonesian convention uses a dot); shifts crossing midnight are explicit ("22.00 – 06.00, berakhir hari berikutnya") |
| **Time zone** | Tenant and work-site time zone chosen from WIB / WITA / WIT, not a raw IANA list |
| **Phone** | `type="tel"`, accept `08…` and `+62…`; store `+62` |
| **CIDR ranges** (work sites) | One per line; validated by `ipRangesSchema`; server errors name the invalid line |
| **Salary formula** | Monospace field; validated by the allowlisted parser on the server; errors name the position of the fault |
| **Files** | Show accepted types and the size limit **before** selection (photo 512 KB, attachment 5 MB, document 10 MB, import 10 MB); type is verified server-side from content, so the message on rejection must not blame the file name |
| **Password** | 12–128 characters (`passwordSchema`); show the rule before the user types; offer show/hide; `autoComplete="new-password"` |

## 6. Long and Destructive Forms

- **Import** is a staged flow, not a form: upload → preview → fix → commit (`04-USER-FLOWS.md` Flow 3). Nothing is written to employees until commit.
- **Shifts and policy** (`/attendance/shifts`, 765 lines) mixes four forms on one page. Each section saves independently and says which section was saved.
- **Reject** actions require a reason (punch review: 4–500 characters). The reason field is the confirmation.
- **Unsaved changes** on long forms should warn on navigation. Not built anywhere.

## 7. Checklist

- [ ] Visible label on every field; "(wajib)" on required ones
- [ ] `required`, `autoComplete`, `inputMode` set appropriately
- [ ] Server `details` mapped onto fields; unmapped errors in a summary
- [ ] Focus moves to the first invalid field on submit
- [ ] Submit disabled and relabelled while in flight
- [ ] Input kept on failure
- [ ] Identifiers never use `type="number"`
- [ ] PII fields masked unless the viewer may unmask
- [ ] File limits stated before selection
