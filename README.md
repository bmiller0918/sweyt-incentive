# Sweyt Incentive — Import & Criteria (Phase 1)

Drag-and-drop CSV/Excel import with a NetSuite-style (and beyond) filter and criteria builder. This is the data foundation for a commissions and incentive-plan application.

## What's here

- **Upload**: `.csv .tsv .xlsx .xls .xlsm`, sheet picker, header-row picker with preview, delimiter and encoding sniffing, file type validated by content.
- **Column typing**: text / integer / decimal / currency / percent / date / datetime / boolean, inferred and overridable per column. Handles `$1,234.50`, `(500)`, `500-`, `12/31/25`, Excel serials, `Y/N`.
- **Grid**: virtualized, sortable, type badges in headers.
- **Criteria builder**: unlimited nested AND / OR groups with NOT, type-aware operators (text incl. regex + case toggle; number incl. between / any of; date incl. relative presets like *this fiscal quarter*, *last N days*), value sources (literal, another field, `{{param}}`), per-condition "rows this removes" badge, live match counts, row-level explain, disable-without-deleting.
- **Saved criteria sets** with automatic version history and an audit log.
- **Export** filtered rows to CSV or XLSX with formula-injection sanitising.
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
   - optionally `MAX_UPLOAD_MB`, `FISCAL_YEAR_START_MONTH`, `WEEK_STARTS_ON`
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
  evaluate.ts   compile + match + impact + explain
server/src/
  index.ts      Fastify bootstrap, serves web/dist in production
  db/           Drizzle schema + driver selection (PGlite vs Postgres)
  parse.ts      CSV/Excel parsing, header row handling
  rowcache.ts   typed-row LRU cache
  export.ts     CSV/XLSX writers with injection guard
  routes/       imports, query, explain, export, criteria sets
web/src/
  App.tsx                     shell + import list
  components/UploadFlow.tsx   dropzone → sheet/header picker → commit
  components/ImportView.tsx   header, criteria panel, grid, explain modal
  components/CriteriaBuilder.tsx  recursive group/condition editor
  components/DataGrid.tsx     virtualized grid with type selectors
```

## API

| Method | Path                         | Purpose                                              |
| ------ | ---------------------------- | ---------------------------------------------------- |
| POST   | `/api/uploads`               | multipart file → parsed sheets + previews (held 15 min) |
| POST   | `/api/uploads/:id/commit`    | `{sheet, headerRow, name}` → creates import          |
| GET    | `/api/imports`               | list                                                 |
| GET    | `/api/imports/:id`           | detail incl. columns + warnings                      |
| PATCH  | `/api/imports/:id`           | rename / override column types                       |
| DELETE | `/api/imports/:id`           |                                                      |
| POST   | `/api/imports/:id/query`     | `{criteria, params, offset, limit, sort}` → rows, counts, per-condition impact, errors |
| POST   | `/api/imports/:id/explain`   | `{criteria, rowIndex}` → which conditions passed     |
| POST   | `/api/imports/:id/export`    | `{criteria, format: csv|xlsx}` → file                |
| CRUD   | `/api/criteria-sets[/:id]`   | saved criteria; `GET /:id/versions` for history      |

## Not yet built (planned)

- Formula / computed columns (safe expression language)
- Summary (group-by + HAVING) view
- Lookup / join against a second file
- Fuzzy name matching
- Canonical field mapping UI (table exists)
- Import profiles (re-import same layout in one click)
- Authentication and multi-tenancy (`organization_id` columns are already in place)
- Connectors (CRM, NetSuite) — the import pipeline takes a `Grid` of strings, so any source that can produce rows plugs in at `server/src/parse.ts`
