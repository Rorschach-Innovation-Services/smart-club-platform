# API reference

The API is one Hono app on Lambda behind the API Gateway `$default` route. Source:
`packages/api/src/index.ts`. All computation stays client-side; this layer is thin,
tenant-scoped CRUD (see [ADR 0004](../architecture/0004-thin-crud-client-side-compute.md)).

## Conventions

- **Base URL:** the `api` output from `sst deploy` (`VITE_API_URL` in the SPA).
- **Auth:** protected routes require `Authorization: Bearer <Cognito ID token>`. The token
  carries a `memberships` claim (`[{ tenantId, role, clubIds }]`) stamped by the
  PreTokenGeneration Lambda.
- **Tenant resolution:** the request tenant comes from the host (prod custom domains) or an
  `x-tenant` header (dev). The caller must have a membership for that tenant or the request
  is `403`. This is the tenant-isolation boundary.
- **Roles:** `admin` (whole tenant) or `rep` (only their `clubIds`).
- **Concurrency:** club and series writes use optimistic concurrency on a `version` field.
  A stale write returns **`409`** with `{ "error": "… changed; refetch" }`; the client should
  refetch and retry.
- **Errors:** JSON `{ "error": "<message>" }` with status `400` / `401` / `403` / `404` /
  `409` / `500`.

## Resources

| File                               | Routes                                                    |
| ---------------------------------- | --------------------------------------------------------- |
| [tenant.md](tenant.md)             | `GET /tenant`, `PUT /tenant/config`, `GET/PATCH /me`      |
| [clubs.md](clubs.md)               | `GET /clubs`, `/clubs/:id` and sub-resources              |
| [signup.md](signup.md)             | public `GET/POST /club-signup`, `/admin/club-signup-link` |
| [series.md](series.md)             | `GET/POST /series`, `/series/:id`, duplicate              |
| [registration.md](registration.md) | public `GET/POST /register/:clubId`                       |
| [users.md](users.md)               | `POST /admin/users` (invite)                              |

## Authorization matrix

| Route group                                            | Public | Rep (own club) | Admin |
| ------------------------------------------------------ | :----: | :------------: | :---: |
| `GET /tenant`, `/register/*`, `/club-signup`           |   ✓    |       ✓        |   ✓   |
| `GET/PATCH /me`                                        |   —    |       ✓        |   ✓   |
| `GET/PATCH /clubs/:id`, exco, docs, reg-link           |   —    |    own only    |   ✓   |
| `GET /clubs`, `/admin/club-signup-link`                |   —    |       —        |   ✓   |
| all `/series` writes, `/tenant/config`, `/admin/users` |   —    |       —        |   ✓   |
