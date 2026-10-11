# Deploy — Chain Reaction hosted demo

How the `crx-server` binary is packaged and how the demo gets a public URL
under the custom domain. Nothing here is deployed automatically yet: there is
no `FLY_API_TOKEN` in CI (§15.3), so all deploys below are manual until Erwin
adds the token.

## What is here

| File | Purpose |
|---|---|
| `Dockerfile` | Three stages: build the web shell with Node 22, build `crx-server` with the native toolchain, then a slim runtime with just the binary + `web/dist`. |
| `fly.toml` | Fly.io app config. |

**Internal port: 8080.** The binary listens on `$CRX_PORT` (default 8080);
Fly's edge terminates TLS on 443/80 and forwards to `internal_port = 8080` in
`fly.toml`. To move it, change both the `CRX_PORT` env and `internal_port`
together.

## Run the image locally

```sh
docker build -f deploy/Dockerfile -t crx-server .
docker run --rm -p 8080:8080 crx-server
# then: curl -X POST localhost:8080/api/sim -d '{"seed":7}'
```

Without Docker, the server runs from a normal build (from the repo root):

```sh
cmake --preset native-release && cmake --build --preset native-release
./build/native-release/crx-server --port 8080 --web-dir web/dist
```

## Deploy to Fly.io

One-time setup:

```sh
brew install flyctl            # or: curl -L https://fly.io/install.sh | sh
fly auth login
fly apps create petrogrid # keep it in sync with fly.toml
```

Every deploy (from the repo root, so the build context includes `engine/`,
`apps/` and `web/`):

```sh
fly deploy . --config deploy/fly.toml
# if flyctl cannot find deploy/Dockerfile, pin it explicitly:
fly deploy . --config deploy/fly.toml --dockerfile deploy/Dockerfile
fly status && fly logs
```

Check the app responds: `https://<app>.fly.dev` serves the front end and
`https://<app>.fly.dev/api/sim` (POST) opens sessions.

**CI/CD later (§15.3):** create a deploy token with `fly tokens deploy` and
store it as the `FLY_API_TOKEN` GitHub secret; the deploy step then runs
`fly deploy --access-token "$FLY_API_TOKEN" ...` on every push to `main`.
Railway is the documented fallback host — any Docker host runs the same
image; only the DNS target changes.

## Custom domain — DNS records

The demo lives at **demo.petrogrid.xyz** (decided 2026-10-10; corrected from
an earlier typo). The apex
`petrogrid.xyz` and `www` belong to the main website — keep them pointed
wherever the site is hosted, never at Fly. The demo subdomain uses direct
A/AAAA records at the registrar pointing at the `petrogrid` Fly app — **no
CNAME and no record change is needed for the app rename**: the records
already target the live app, so deploying with `app = "petrogrid"` lands on
the same domain.

1. Register the hostnames with Fly (provisions TLS certificates):

   ```sh
   fly certs add demo.petrogrid.xyz
   ```

   If cert validation needs TXT records, `fly certs add` prints the exact
   `_acme-challenge` records — create them at the registrar, then check with
   `fly certs check demo.petrogrid.xyz`.

2. DNS records (already in place at the registrar):

   | Type | Name  | Value               | Notes |
   |------|-------|---------------------|-------|
   | A    | `demo` | `66.241.125.211`   | Fly app IPv4 (anycast) |
   | AAAA | `demo` | Fly app IPv6       | matching IPv6 address |

3. `https://demo.petrogrid.xyz` serves the demo from the same machine
   `https://petrogrid.fly.dev` does — the domain is a DNS fact, not a
   rebuild (§14).

## Notes

- Sessions are in memory only (cap 16, 10-minute inactivity expiry, §7.4):
  a redeploy or restart wipes them by design. A run is reproduced by
  replaying the same seed and commands.
- The Fly machine stays up (`auto_stop_machines = false`, `min_machines_running
  = 1`): the demo is always warm, at the cost of a continuously running machine.
