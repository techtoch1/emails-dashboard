# ALIGNED — Workspace Licenses dashboard

A read-only dashboard over every Google Workspace tenant ALIGNED manages:
how many email accounts each domain has, which tenant hosts each domain, which
license each account holds, seats left, storage per account and per tenant,
last login, accounts created and deleted, and the monthly income from each domain per email
with prices the accountant enters.

It runs on the same server as the quotation system but separately from it:
its own port (3100), database, service and nginx site.

## What each requirement maps to

| Need | Where |
|---|---|
| 1. Exact number of emails per domain | **Overview → Domains**: emails, active, suspended per domain |
| 2. Which tenant hosts each domain | **Overview → Domains → Hosted on**. Uses each tenant's domain list from Google, including domains that have no accounts yet |
| 3. Accounts created and deleted, for accounting | **Created & deleted**: pick a date range, see a per-domain summary and each account, then export to CSV. **Monthly billing** shows the same counts per month |
| 4. Which license each email holds | **Accounts → License**, plus any extra licenses such as Vault or Archived User |
| 5. Licenses remaining per tenant | **Overview → Tenants**: assigned vs purchased with a bar. See "Seats" below |
| 6. Storage per email | **Accounts**: Gmail, Drive and total GB |
| 7. Storage per tenant | **Overview → Tenants**: the sum across accounts, and pooled storage when Google reports it |
| 8. Last login per email | **Accounts → Last login**, with a filter for "not in 30/90 days" and "never" |
| 9. A price per domain and the income per email | **Prices** (accountant): a price per email per month for each domain, optionally a different price per license. Every change is logged. Income appears per account, per domain, per tenant and in **Monthly billing**, which prorates by day |

## How it reads Google (read-only)

The app uses one **service account with domain-wide delegation**. In each
tenant, a super admin authorizes the service account's client ID for these
scopes, and the app then reads as a named admin of that tenant. Nobody's
password is stored, and access can be withdrawn at any time from that tenant's
Admin console.

| Scope | Used for |
|---|---|
| `admin.directory.user.readonly` | accounts, status, last login, creation date |
| `admin.directory.domain.readonly` | the domains each tenant hosts |
| `admin.reports.usage.readonly` | storage per account and per tenant, and seat counts |
| `admin.reports.audit.readonly` | who created or deleted an account, and when |
| `apps.licensing` | which license each account holds |

Google publishes no read-only scope for the License Manager API, so
`apps.licensing` is the one scope that could write. The app only sends GET
requests with it, and `test/google.test.js` checks that the client sends
nothing else to Google.

**Billing-only admins are not enough.** A billing admin role cannot read the
user list or the reports. The admin the app reads as needs a role with
read access to Users, Reports and License management. A super admin works.
For least privilege, use a custom role with only those read privileges.

### One-time Google setup

1. In any Google Cloud project (for example, one in ALIGNED's own tenant), enable the
   **Admin SDK API** and the **Enterprise License Manager API**.
2. Create a service account. You don't need to give it any IAM roles. Create a
   **JSON key** for it and copy the key to the server (see Deployment). Never commit the key.
3. In **each tenant**: go to Admin console → Security → API controls →
   Domain-wide delegation → Add new. Paste the service account's **client
   ID** and the scope list. The app's **Tenants** screen shows both, ready to copy.
4. In the dashboard: **Tenants → Add tenant** with a name and the admin email
   to read as, then **Test connection**. Each API shows ✓ or ✗ with Google's own message.

## Seats ("licenses remaining")

On **Flexible** plans Google bills per account and has no seat cap, so
"remaining" doesn't apply. On **Annual** plans, the number of seats bought
isn't in the Directory or Licensing API. The app shows whatever Google's usage
report gives (`accounts:*_total_licenses`). An admin can also enter the
purchased seats per tenant and license under **Tenants**. An entered number
takes precedence.

## How "created" and "deleted" are dated

- **Created**: Google's own account creation time.
- **Deleted**: the admin audit log's timestamp and actor when Google reported
  the deletion (the log covers about six months). Otherwise it's the date of
  the first daily sync that no longer found the account.

The app takes one snapshot per tenant per day, so the history starts on the
first sync. To keep the history from the earlier static dashboard, import it
once:

```
npm run import-legacy -- /path/to/dashboard.html
```

The import creates the tenants it finds, using a placeholder admin address.
Set the real admin address under **Tenants** before the first live sync.

## Monthly billing

Each account brings in `price × days it held a license that month ÷ days in the month`.
This is income (what clients pay ALIGNED), not what Google charges.
This matches how Google bills Flexible plans. Suspended accounts still hold a
license, so they're billed. Unlicensed accounts bring in nothing unless you set a
price for "Unlicensed". If a sync is missed, the previous day's snapshot fills
that day. For the current month, days after the latest sync are projected from
the latest sync. The per-email CSV is the detail the accountant needs.

## Roles

- **admin**: everything, including tenants, sync and dashboard users
- **accountant**: views everything and sets prices and currency
- **viewer**: read-only

## Running locally

```
npm install
DB_FILE=data/demo.db npm run demo          # invented tenants, 100 days of history
DB_FILE=data/demo.db npm start             # http://localhost:3100 — demo / demo-password-1
npm test
```

Requires Node 22.13 or later. Storage is Node's built-in SQLite, so there's no native module to compile.

## Deployment

Deployment runs from GitHub Actions (`.github/workflows/deploy.yml`)
on every push to `main`, or by hand from the Actions tab.
It runs the tests, copies the app to `~/workspace-dashboard` on the server over
SSH, and runs `ops/setup-server.sh`, which:

- uses the system Node.js if it's 22.13 or later. Otherwise it installs a private Node 22 under
  `~/.local` for this app only, so the quotation app's Node is never changed
- installs the `workspace-dashboard` systemd service on port 3100
- adds an nginx site for the hostname, and requests an HTTPS certificate with certbot when DNS
  already points at the server
- writes the service-account key and creates the first admin login, if those secrets are set
- fails the deploy if the app doesn't answer on 127.0.0.1:3100

Repo secrets (Settings → Secrets and variables → Actions):

| Secret | |
|---|---|
| `WSD_SSH_HOST` | server hostname or IP (required) |
| `WSD_SSH_USER` | SSH user with sudo (required) |
| `WSD_SSH_PASSWORD` | that user's password (required) |
| `WSD_SSH_PORT` | optional, default 269 |
| `WSD_HOSTNAME` | public hostname of the dashboard, default `emails.aligned-tech.com` |
| `WSD_ADMIN_USER`, `WSD_ADMIN_PASSWORD` | first dashboard login, used only while no login exists |
| `WSD_SA_KEY_JSON` | the Google service-account key file's contents |

To create more logins by hand on the server:
`cd ~/workspace-dashboard && DB_FILE=~/workspace-dashboard-data/dashboard.db node ops/add-user.js <username> <role>`.

The database is kept in `~/workspace-dashboard-data`, outside the
code directory, so redeploying never touches it. Back that directory up.

Environment: `PORT` (3100), `DB_FILE`, `GOOGLE_SA_KEY_FILE`, `SYNC_HOUR_UTC`
(3, so the sync runs daily at 03:00 UTC), and `DISABLE_SCHEDULER=1` to turn the daily sync off.
