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
fly apps create chain-reaction # or any name; keep it in sync with fly.toml
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

## Custom domain — DNS records for Erwin

Buy the domain at any registrar, then wire it to the Fly app. Values below
assume the app name `chain-reaction` and the domain `your-domain.example` —
substitute the real ones.

1. Register the hostnames with Fly (provisions TLS certificates):

   ```sh
   fly certs add your-domain.example
   fly certs add www.your-domain.example
   fly ips list        # shows the app's dedicated IPv4/IPv6
   ```

   If cert validation needs TXT records, `fly certs add` prints the exact
   `_acme-challenge` records — create them at the registrar, then check with
   `fly certs check your-domain.example`.

2. Create these records at the registrar (apex values come from
   `fly ips list`; the CNAME target is the app's `fly.dev` name):

   | Type  | Name | Value                        | Notes |
   |-------|------|------------------------------|-------|
   | A     | `@`  | the dedicated IPv4 address   | apex → Fly dedicated IP |
   | AAAA  | `@`  | the dedicated IPv6 address   | apex, IPv6 |
   | CNAME | `www`| `chain-reaction.fly.dev.`    | www subdomain |

   If the registrar supports apex CNAME flattening (Cloudflare and most
   modern DNS providers do), a single flattened `CNAME @ → chain-reaction.fly.dev`
   can replace the A/AAAA pair — but A/AAAA works everywhere.

3. Verify propagation, then `https://your-domain.example` should serve the
   demo. Until DNS propagates, `https://<app>.fly.dev` always works — the
   demo link is a DNS record swap, never a rebuild (§14).

## Notes

- Sessions are in memory only (cap 16, 10-minute inactivity expiry, §7.4):
  a redeploy or restart wipes them by design. A run is reproduced by
  replaying the same seed and commands.
- The Fly machine suspends when idle (`auto_stop_machines = "suspend"`); the
  first visitor after idle pays a short cold start.
