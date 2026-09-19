# `credentials-github-app` - the `github-app` git auth strategy

The GitHub App credential backend, **moved out of the core** (operator rule
2026-09-19: the core is the absolute minimum - it loads the config, discovers
the sources, installs the plugins and resolves `${cred:...}` through the
credentials Definition; a backend-specific credential implementation is a
plugin).

```
Provider  ->  Definition  <-  Consumer
```

This plugin **consumes** the host's credentials service (`ctx.credentials`) and
registers a **git auth strategy** for `auth.type: github-app`:

```ts
ctx.credentials.registerGitAuth({
  type: 'github-app',
  async args({ ref, value, auth }) { /* value = the App PRIVATE KEY (PEM) */ },
})
```

The core keeps only the generic step "a resolved credential value becomes the
`git -c ...` arguments of one source fetch": it asks the service for a handler of
the source's `auth.type` and dispatches. There is no JWT, no installation-token
call and no github-app branch in the kernel any more.

## What it does

1. `POST {apiBase}/app/installations/{installationId}/access_tokens` with an
   RS256 JWT (`iat` -60s, `exp` +9min, GitHub's documented App flow) signed by
   the App private key the credentials providers resolved for
   `auth.credential`;
2. caches the minted token **in memory** with a 5-minute safety skew, so a long
   running serve mints a fresh token on the next source resolution instead of
   failing on an expired one;
3. hands the core `-c credential.helper=` + `-c http.extraheader=Authorization:
   Basic <base64(user:token)>`, which is passed to a SINGLE git invocation and
   never written to `.git/config`.

No value is ever logged, echoed or committed: errors name the credential
REFERENCE and the HTTP status only, and the API body is redacted
(`"token": "<redacted>"`).

## Config

| key | default | meaning |
| --- | --- | --- |
| `apiBase` | `https://api.github.com` | GitHub REST base (GitHub Enterprise); a source `auth.apiBase` wins |
| `username` | `x-access-token` | basic-auth username; a source `auth.username` wins |

The source `auth` block carries the per-source fields:

```yaml
- kind: git
  id: private-plugins
  url: https://github.com/nexuslbs/workbench-plugins-private
  ref: main
  auth:
    type: github-app          # dispatched to this plugin
    credential: GITHUB_APP_KEY # a NAME; the PEM is resolved at fetch time
    appId: 3967918
    installationId: 138119822
```

## Why it declares the capability WITHOUT a provider id

It implements **no** `credentials@1` provider (`resolve` / `explain` / `list`):
the App private key is resolved by the ordinary providers (env / file /
project-env / user-env in `plugins/credentials-basic`), and this plugin only
turns that value into a token. Declaring a provider id here would claim an
implementation that does not exist.

It still declares the capability - `{ "id": "credentials", "version": 1 }`, no
`provider` - because that is what makes the core load it in its CREDENTIALS
phase, together with the providers, BEFORE any credential-dependent source is
resolved. A `git` source with `auth.type: github-app` needs the `github-app` git
auth handler to be registered already; a strategy plugin that arrived later
could not serve the source it exists for.

Load order: the plugin is listed in the config roster (`plugins:`) and must be
reachable from a source that needs no credential (a `path` source or the PUBLIC
`git` source). The source `auth` still needs a VALUE provider: a config that
loads `credentials-basic` (and this plugin) from credential-free sources and
names a credential-free `auth`-bearing source resolves and fetches the private
source afterwards, in the same boot.

## Tests

`test/credentials-github-app.test.ts` covers the JWT shape, the mint + cache
with an injected `fetch`, the handler's required fields, and the
`registerGitAuth` registration/disposal through a stub credentials service.
