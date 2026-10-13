# Sweyt Incentive — Import & Criteria (Phase 1)

Drag-and-drop CSV/Excel import with a NetSuite-style (and beyond) filter and criteria builder. This is the data foundation for a commissions and incentive-plan application.

## What's here

- **Upload**: `.csv .tsv .xlsx .xls .xlsm`, sheet picker, header-row picker with preview, delimiter and encoding sniffing, file type validated by content.
- **Linked imports (parent / child)**: make one import a child of another on a key (`Deal ID` = `ID`), at upload time or later via **Links**. The child's rows gain the parent's fields (`Deals: Rep`, `Deals: Close Date`…); the parent's rows gain roll-ups of the child you choose (`Payments: Sum of Amount`, `Payments: Count`). Linked columns work everywhere — filters, summaries, calculations, drill-down, export, saved incentives — and are marked ↗ in the grid. Keys match case-insensitively after trimming; cycles are refused.
- **Column typing**: text / integer / decimal / currency / percent / date / datetime / boolean, inferred and overridable per column. Handles `$1,234.50`, `(500)`, `500-`, `12/31/25`, Excel serials, `Y/N`.
- **Grid**: virtualized, sortable, type badges in headers.
- **Period filter**: pick the date column (e.g. Close Date) and a period — this / last / next quarter, fiscal quarter, fiscal year, year, month, YTD, QTD, last N days, or a custom start–end. It is an ordinary criteria node (`period:<field>`), shows as a chip, and the Calculate stage resolves comp plans as of the period's end date.
- **Column header filters** (the everyday path): click the funnel on any header for an Excel-style list of distinct values with counts (search, All/None, "only"), plus a type-aware condition row (contains / between / after / relative dates…). Filters on different columns AND together and show as chips above the grid. Counts in the list reflect the other active filters.
- **Advanced criteria builder** (behind an *Advanced* toggle): unlimited nested AND / OR groups with NOT, type-aware operators (text incl. regex + case toggle; number incl. between / any of; date incl. relative presets like *this fiscal quarter*, *last N days*), value sources (literal, another field, `{{param}}`), per-condition "rows this removes" badge, live match counts, row-level explain, disable-without-deleting. Header filters are ordinary nodes in the same tree (ids `hf:<field>` / `hfo:<field>`), so both views edit one criteria set.
- In the builder, *is / is not / is any of / is none of* open a pick-list of the column's real values (search, counts, custom entry) instead of a text box.
- Incomplete conditions (no value typed yet) are ignored rather than matching nothing.
- **Summarize** (stage 2): group by any columns, aggregates (sum / count / count distinct / avg / min / max) with custom labels. Toggle Detail / Summary; export either. A totals bar always shows sums of the filtered rows. (A HAVING filter on summary rows is supported by the engine and saved sets; its editor is hidden for now.)
- **Drill-down**: expand any summary row to see the detail rows behind it — pick which columns to show and drag them into the order you want — with a subtotal, so you can audit how a number was built.
- **Calculate** (stage 3): formulas over the summary rows — `[Sum of Amount] * 12%`, `IF([Won] > plan.quota, …)`, tiered payouts with `MIN`/`MAX` — using a safe expression language (`shared/src/formula.ts`: arithmetic, comparisons, AND/OR/NOT, IF, MIN, MAX, ROUND, ABS, COALESCE, FLOOR, CEIL, ISBLANK; `12%` literals; later rows can reference earlier results). Pick a **rep column** and each row looks up that rep's comp plan, exposing its parameters as `plan.rate`, `plan.quota`, etc., plus a `Plan` column. Rows whose rep has no plan are flagged.
- **Comp plans**: named plans with free-form parameters (rate, quota, accelerator…), a **tier table** (from → rate rows; *marginal* or *whole-amount* payout), and an **effective period** chosen from presets (this/last/next fiscal year, quarter, month… resolved to concrete dates when picked) or a custom range.
- **Weighted components** (Comp Plans › Plans, rates and quotas): a plan's **target incentive** (variable pay at 100%) is split across components — New ARR, Renewals, Services… — by **weight**, entered as a *% of the target incentive*, a *$ amount*, or *by quota* (quota-weighted components share whatever is left, in proportion to their quotas). Each component carries its own **quota**, so its on-target rate is target ÷ quota, and an **attainment tier table** (from an attainment % of quota, pay a % of the on-target rate: 100% to quota, 150% above it; marginal or whole-amount). The editor shows the resolved dollars, rates and a 120%-attainment check, and flags weights that don't add to 100%. In Calculate, `COMPONENT([Sum of Amount], "New ARR")` and `COMPONENT_RATE(...)` pay under a component of the rep's core plan (`COMPONENT(x, "New ARR", "spiff")` for another slot), and `plan.target_incentive`, `plan.new_arr_quota`, `plan.new_arr_rate`, `plan.new_arr_target` expose the resolved numbers. Logic: `shared/src/components.ts` (pure, unit-tested).
- **Threshold types** say what a tier table's thresholds are measured in: built-in *Dollars*, *% of quota*, *Count*, plus your own (name, unit label, optionally "% of plan parameter X") — e.g. *Calls* for an SDR plan, or *% of target* scaling by `plan.target`.
- **Employee types**: roles (Enterprise AE, SDR, …) with default plan assignments per slot and default base salary / quota. Most setup happens here once.
- **Employees**: the people who earn commission — name (as it appears in the data, matched case-insensitively), type, title, base salary, quota, named bonuses, start date, **status** (active, terminated, parental/medical/other leave, inactive, with a since-date; `employee.status` in formulas) — and their own **plan assignments**, which override the type's per slot. `plan` is the core plan, extras are `spiff`, `bonus`, etc. Assignments carry effective dates; the one in force at the end of the Period wins per slot (employee's own beats inherited). A person's quota (own, else type default) overrides `plan.quota`, so one plan serves many quotas. Add employees one at a time or tick names from an import column (optionally assigning a type).
- **Tiered payouts**: `TIER([Sum of Amount])` in Calculate applies the rep's core-plan tier table; `TIER([Sum of Amount], "spiff")` uses the plan in the `spiff` slot. `TIER_RATE(...)` returns the rate reached. "+ Tiered payout" adds both in one click.
- **Formula scope per rep**: `plan.<param>`, `<slot>.<param>`, `employee.base_salary`, `employee.bonus_total`, and each bonus by label (`employee.car_allowance`). Missing values yield blank, never zero.
- **Incentives** (saved pipelines): Save captures the period, filters, summary, drill-down columns and calculations for an import under a name + description, with automatic version history and an audit log. The **Incentives** register lists them all (period, filters, grouping, calculations, last updated); click one to reopen the import with everything restored.
- **Export** filtered rows to CSV or XLSX with formula-injection sanitising.
- **Commissions** (runs): pick a deals import, the rep column, the amount and close-date columns, optionally other people paid on each deal (SE, manager, partner, BDR columns) and a date range, and calculate **one commission line per person per deal**. Each person's rate comes from the comp plan in force on the deal's close date (effective-dated assignments, so a mid-year recast takes effect on its start date). Attainment accrues per person in close-date order over the run's deals; a deal that crosses a tier threshold is **split into one line per band** (the base rate up to quota, the accelerated rate above it), exactly as the two-row Excel approach but automatic. Credit memos unwind the bands they fall back through. Lines carry the plan, tier band, slice amount, rate, payout rounded to cents, attainment before and after, and a note when nothing could be paid (unknown person, no plan in force, no amount, tiers without a quota). **Weighted plans** pay one line per component instead: the run setup lists every component name found on the plans (**Plan components**) and maps each to a column (matched by name where it can), each person's attainment accrues per component against that component's quota, a value that crosses the component quota is split into one line per band at the component's tiered rates, and lines carry the component name (shown in the lines table and the CSV). A component left unmapped pays nothing and the run says so; people on plans without components are paid from the amount column as before, so both kinds of plan can share one run. Results show totals by person, the lines, and export to CSV. Engine: `shared/src/lines.ts` (pure, unit-tested).
- **Pay now / on hold**: every line is either *Pay next payroll* (the month after the close, lag configurable per run) or *On hold* with a reason. **Hold rules** on a run (column + operator + value → reason, first match wins) put deals on hold automatically from the data (e.g. `Billing is not Upfront`, `TFC is true`, `Start Date after …`); anything can also be held or released by hand, singly or in bulk. Releasing a held line pays it on the payroll after the release date, like a fresh close. The run view has an **on-hold dashboard** (total, by reason, by person) and an on-hold CSV export; every hold and release is audit-logged. **Hold reasons** are a settings list seeded with the usual five (start delayed > 4 months, can't bill upfront, termination for convenience, delayed payment terms, other). Logic: `shared/src/holds.ts`.
- **Payout rules** (*Payouts › Payout Rules*): workspace-wide checks on the deal data, shaped like a cross-validation rule. A rule has **filters** (which deals it applies to: `Customer is Acme`; none = every deal), **requirements** (field + *Must be* / *Cannot be* + operator + value: `Amount cannot be greater than 10,000`, `Billing must be Upfront`, `Start Date must be within next 90 days`) with a **Require all** toggle (break any requirement vs. break every one), and an **action**: the hold reason and a hold message. Every commission run applies the rules, in order, before the run's own hold rules; a deal that breaks one starts on hold with that reason and the message as its note, for review under Payouts On Hold. Rules match columns by header name, so one rule serves every import with that column; a rule naming a column an import lacks is skipped for that import with a warning on the run. The page dry-runs the rules against any import (per-rule flagged counts and the flagged deals) and tests unsaved edits live. Logic: `applyPayoutRules` in `shared/src/holds.ts`.
- **Accounting** (subledger, the run's Accounting tab): commissions are accrued in their pay month (held lines are not booked). Each **employee type** carries a cost treatment: *capitalize* (contract acquisition cost) or *expense when paid* (e.g. BDRs), and the type is the department in the **monthly accrual by department** report (capitalized vs expensed, with the credit to accrued commissions). Capitalized lines get a **straight-line amortization schedule** at line level under a company-wide **policy**: over the contract term from the subscription start (a run can map subscription start + term or end columns from the deal data), or over one estimated customer life from the pay month (the practical expedient). The tab shows the **capitalized balance rollforward** (opening, additions, amortization, closing per month), the schedules, and the **journal entries** (accrual per pay month, amortization per month, by department), with CSV exports of the full schedule (one column per month) and the entries. Logic: `shared/src/accounting.ts`; cents are rounded per month with the remainder in the last month so every schedule ties out exactly. `samples/deals-2026.csv` has SE/BDR payees, subscription start and term columns to try it with.
- **Sign-in**: email + password accounts with 30-day session cookies. First visit with no accounts shows a one-time **create the admin account** screen; after that every `/api/*` route except `/health` and `/api/auth/*` requires a session. Admins add users under *Employees › Users* (a temporary password is shown once; the user must change it before anything else, enforced by the server) and remove them. Passwords are hashed with scrypt; only a hash of each session token is stored; login is rate-limited per IP + email. Logic: `server/src/auth.ts`.
- **Global Settings** (sidebar *Setup › Global Settings*, admins edit, everyone can read), laid out like NetAsset's setup page with five tabs. **General**: the go-live date (no month before it can be closed; new runs default to deals closed on or after it), fiscal year start month and week start (previously only env vars; the first start seeds them from the environment), the default pay lag, whether amortization records may be entered by hand, the amortization record prefix and minimum digits (`AMRT0001`), and period controls (allow a release that pays in a closed month; allow reopening the latest closed month). **System Features**: switches that hide what the business doesn't use (accounting subledger, payout holds, incentives, weighted components, linked imports, and the not-yet-built pages), the quick-access buttons on a commission run (hold, release, pay now, the exports, delete), and *Restrict feature permissions*: each write action (import data, save incentives, edit plans, edit employees, calculate runs, hold/release, accounting setup, close months) is open to all users or admins only; the server enforces it on every request, reads stay open. **Import Tools**: CSV templates for deals and child payments plus links to the import wizard, links, employees and users. **Licensing**: edition and status, and usage counts (employees by status, users, imports, plans, runs, lines by status, amortization records, closed months) with a sync button. **Manage Upgrades**: upgrade preference and next upgrade date, the running version, schema migration and last-upgraded date, who receives release notes, and a one-time in-app message after an upgrade. Stored as one JSON document (`app_settings`), validated by `shared/src/settings.ts`; `server/src/appSettings.ts` caches it, `server/src/permissions.ts` maps requests to permissions.
- **Navigation & theme**: *Overview* pinned at the top, then sidebar sections *Data & Imports*, *Comp Plans*, *Payouts*, *Accounting*, *Statements & Reports* and *Employees*. Existing screens sit inside them (Commission Payroll, Payouts On Hold and Amortization Registers open the commission runs; Payout Rules is its own page; Payout Settings sits at the bottom of Data & Imports and opens hold reasons; Accounting Settings opens the accounting policy; Spiffs, Accelerators, and Bonus Plans opens incentives); pages not built yet show a Coming soon placeholder. Layout lives in `SECTIONS` in `web/src/App.tsx`. The sidebar highlight is Sweyt green (`--color-brand`). Dark theme: warm charcoal surfaces with a terracotta accent, applied by remapping Tailwind's color tokens in `web/src/index.css` (components use ordinary `slate` / `indigo` classes; `bg-panel` is the card surface).
- **Deploy**: single Docker image, `/health` endpoint, Railway config.

## Stack

| Part      | Tech                                                                                      |
| --------- | ----------------------------------------------------------------------------------------- |
| `shared/` | Criteria AST (Zod), evaluator, coercion, relative dates — pure TypeScript, fully unit-tested |
| `server/` | Fastify 5, Drizzle ORM, PGlite locally / Postgres on Railway, PapaParse, SheetJS          |
| `web/`    | React 19, Vite, Tailwind 4, TanStack Virtual, react-dropzone                             |

### Why in-memory evaluation

Criteria are stored as a versioned JSON AST and evaluated in memory by `shared/src/evaluate.ts`. Rows for an import are loaded from Postgres once and cached (LRU, 8 imports). For files up to the 50 MB limit this is fast, keeps one evaluator for preview / impact / explain / export, and means the AST — not SQL — is the source of truth. When data outgrows memory, add an AST → parameterized SQL compiler beside the evaluator; nothing stored changes.

## Run locally

Requires Node 22+. No database install needed — PGlite stores data in `./data/pglite`.

```bash
corepack enable
pnpm install
pnpm dev
```

- Web: http://localhost:5173 (proxies `/api` to the server)
- API: http://localhost:3000 — `GET /health`

Try `samples/deals.csv`: it exercises messy currency, parenthesised negatives, mixed date formats, blanks, duplicate rows, and a formula-injection cell.

Tests:

```bash
pnpm test
```

## Deploy to Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo. Railway reads `railway.json` and builds the `Dockerfile`.
3. **Add a database**: in the project, **+ New → Database → PostgreSQL**.
4. On the app service, **Variables → + New Variable**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (use the reference picker)
   - `NODE_ENV` = `production`
   - `PORT` = `3000` (Railway otherwise injects a random port that won't match the domain's target port)
   - optionally `MAX_UPLOAD_MB`, `FISCAL_YEAR_START_MONTH`, `WEEK_STARTS_ON` (the calendar values seed Global Settings on first start; after that the Setup page wins)
5. **Settings → Networking → Generate Domain**.
6. Verify: `https://<your-domain>/health` returns `{"ok":true,...}`. Migrations run automatically at startup.

Or from the CLI:

```bash
npm i -g @railway/cli
railway login
railway init
railway add --database postgres
railway up
```

Then set `DATABASE_URL` as above and generate a domain.

## Project layout

```
shared/src/
  types.ts      column types, row shapes
  coerce.ts     parseNumber / parseDate / parseBoolean, type inference
  dates.ts      relative date presets, fiscal periods
  criteria.ts   AST schema (Zod), operator tables
  settings.ts   global settings schema, feature / quick-action / permission catalogs
  evaluate.ts   compile + match + impact + explain
server/src/
  index.ts      Fastify bootstrap, serves web/dist in production
  appSettings.ts  cached global settings (calendar, record numbering)
  permissions.ts  request → permission key for "Restrict feature permissions"
  db/           Drizzle schema + driver selection (PGlite vs Postgres)
  parse.ts      CSV/Excel parsing, header row handling
  rowcache.ts   typed-row LRU cache
  export.ts     CSV/XLSX writers with injection guard
  routes/       imports, query, explain, export, criteria sets, setup
web/src/
  App.tsx                     shell + import list
  components/UploadFlow.tsx   dropzone → sheet/header picker → commit
  components/ImportView.tsx   header, criteria panel, grid, explain modal
  components/CriteriaBuilder.tsx  recursive group/condition editor
  components/DataGrid.tsx     virtualized grid with type selectors
  components/SettingsProvider.tsx  global settings context (feature / quick / can)
  components/setup/SetupView.tsx   Global Settings page (five tabs)
```

## API

| Method | Path                         | Purpose                                              |
| ------ | ---------------------------- | ---------------------------------------------------- |
| POST   | `/api/uploads`               | multipart file → parsed sheets + previews (held 15 min) |
| POST   | `/api/uploads/:id/commit`    | `{sheet, headerRow, name}` → creates import          |
| GET    | `/api/imports`               | list                                                 |
| GET    | `/api/imports/:id`           | detail incl. columns + warnings                      |
| PATCH  | `/api/imports/:id`           | rename / override column types                       |
| GET    | `/api/imports/:id/links`     | this import's parent link and child links            |
| PUT    | `/api/imports/:id/link`      | `{parentImportId, childKey, parentKey}` set/replace the parent |
| PUT/DELETE | `/api/links/:id`         | edit exposed parent fields / child roll-ups; unlink  |
| DELETE | `/api/imports/:id`           |                                                      |
| POST   | `/api/imports/:id/query`     | `{criteria, params, mode: detail\|summary, offset, limit, sort}` → rows, counts, per-condition impact, errors, totals; summary mode returns the summary's `columns` |
| POST   | `/api/imports/:id/values`    | `{field, criteria?, search?}` → distinct values with counts for a header filter |
| POST   | `/api/imports/:id/group-rows` | `{criteria, groupValues}` → detail rows + subtotals behind one summary row |
| POST   | `/api/imports/:id/explain`   | `{criteria, rowIndex}` → which conditions passed     |
| POST   | `/api/imports/:id/export`    | `{criteria, format: csv|xlsx}` → file                |
| CRUD   | `/api/criteria-sets[/:id]`   | saved criteria; `GET /:id/versions` for history      |
| GET    | `/api/config`                | fiscal year start month, week start                  |
| GET/PUT | `/api/settings`             | the global settings document (PUT is admin only)      |
| GET    | `/api/setup/usage`           | workspace counts for the Licensing tab               |
| GET    | `/api/setup/system`          | version, schema migration, last upgraded, server start |
| GET    | `/api/setup/templates/:name` | `deals` or `payments` CSV import template            |
| CRUD   | `/api/threshold-types[/:id]` | built-in + custom threshold types for tier tables    |
| CRUD   | `/api/comp-plans[/:id]`      | plans with `params`, `tiers` and `structure` (target incentive + weighted components) |
| CRUD   | `/api/employee-types[/:id]`  | roles with default plans; `POST /:id/assignments`, `PUT`/`DELETE /api/type-assignments/:id` |
| GET/POST | `/api/commission-runs`     | list runs; `{name, importId, repField, payees[{role,field}], amountField, dateField?, dealKeyField?, from?, to?, components?[{name,field}]}` calculates and stores a run |
| GET/DELETE | `/api/commission-runs/:id` | run with its lines; `GET /:id/export[?status=hold]` downloads the lines as CSV |
| POST   | `/api/commission-runs/:id/hold` | `{lineIds, reasonKey, note?, heldAt?}`; `/release` `{lineIds, releasedAt?}`; `/pay` `{lineIds}` clears a hold |
| GET/POST/DELETE | `/api/hold-reasons[/:id]` | hold reasons (built-ins can't be deleted) |
| CRUD   | `/api/payout-rules[/:id]`    | `{name, message, reasonKey, filters[], requirements[{field, direction, operator, values}], requireAll, enabled}`; `PUT /order {ids}` reorders; `GET /fields` lists column headers across imports; `POST /preview {importId, rules?}` dry-runs the rules against an import |
| GET    | `/api/commission-runs/:id/accounting` | accrual by pay month × department, schedules, rollforward, journal entries; `/accounting/schedule.csv`, `/accounting/entries.csv` |
| GET/PUT | `/api/accounting-policy`    | `{method: contract_term\|customer_life, customerLifeMonths, defaultTermMonths}` |
| CRUD   | `/api/employees[/:id]`       | employees with own + inherited assignments; `POST /bulk` creates many by name (optional type) |
| POST   | `/api/employees/:id/assignments` | add a plan to an employee in a slot; `PUT`/`DELETE /api/assignments/:id` |

## Not yet built (planned)

- Computed columns on detail rows (the formula engine exists; only summary-row calculations are wired up)
- Rep statements, leadership reporting, mid-year recasts
- Splits / credit rules, clawbacks, SPIFs, period close
- Multi-level link chains (a child's child) and many-to-many links
- Fuzzy name matching
- Canonical field mapping UI (table exists)
- Import profiles (re-import same layout in one click)
- Multi-tenancy (`organization_id` columns are already in place)
- Connectors (CRM, NetSuite) — the import pipeline takes a `Grid` of strings, so any source that can produce rows plugs in at `server/src/parse.ts`
