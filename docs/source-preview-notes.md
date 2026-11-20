# v0.1.0-preview.1 release notes draft

This developer preview packages the Credspan source for local work with synthetic membership credentials.

- Issue, hold, present, verify and revoke a synthetic membership credential using the local console and modified walt.id Wallet API v2 peer.
- Use the pinned Node and pnpm versions and the local setup in the [sandbox runbook](https://github.com/m1ngshum/credspan/blob/v0.1.0-preview.1/docs/sandbox.md).
- The console retains the previous credential when a replacement offer fails. The SDK freshness check preserves contributor files, and the documented project diagnostic checks the running API.

See the [compatibility notes](https://github.com/m1ngshum/credspan/blob/v0.1.0-preview.1/docs/compatibility.md) for the exact profile and peer limits. The preview has no prebuilt images or production support. Use an isolated local environment and synthetic data. Review [known security limits](https://github.com/m1ngshum/credspan/blob/v0.1.0-preview.1/SECURITY.md) before using the code. There is no supported migration from a previous public preview. For an existing sandbox, follow the [backup and recovery runbook](https://github.com/m1ngshum/credspan/blob/v0.1.0-preview.1/docs/operations.md) before switching revisions.
