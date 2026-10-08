# Security

Do not include pairing links, bearer tokens, credentials.json, machine logs, or private thread histories in public issues.

The service runs on local stdio and opens no listener. It forwards operations to the trusted T3 server you select. Its token has broader scopes than the tools it exposes. Only trusted clients should use it. Prefer approval-required mode and explicit project/thread ownership in orchestration policy.

Credentials are stored outside the repository. On Windows use scripts/pair.ps1 to restrict ACLs; POSIX modes do not provide equivalent Windows protection. Revoke an exposed token in T3 Settings ? Connections and pair again.

Report suspected vulnerabilities privately through GitHub private vulnerability reporting when available. Otherwise contact the maintainer without exploit details and arrange a private channel. Avoid public disclosure of secrets.

Dependency audits are point-in-time checks, not proof of absence of vulnerabilities. Re-run npm audit and tests before updating a deployed checkout. This project neither patches T3 nor guarantees compatibility with every future nightly build.
