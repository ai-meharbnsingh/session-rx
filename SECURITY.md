# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting. On the repository page:

1. Go to the **Security** tab
2. Click **Report a vulnerability**
3. Describe the issue privately

Do not open a public issue.

## Scope

SessionRx:

- **Reads** local AI CLI session logs (read-only)
- **Redacts** secrets from the Markdown report before rendering
- **Runs** a local server bound to `127.0.0.1` (loopback only, no network listening)

SessionRx does NOT:

- Make network calls or fetch remote resources
- Write user files
- Collect or transmit telemetry
- Access external accounts or credentials

## Facts

- **No network calls.** All code runs on your machine. Nothing is fetched or sent.
- **Never writes user files.** SessionRx only reads logs and displays suggestions; your AI tool applies changes to your config.
- **Suggestions never write.** When SessionRx finds a problem, it shows you the text to add and a ready-made request for your AI tool. SessionRx does not write anything.
- **Secrets redaction.** The report redaction layer removes known secret patterns before rendering. Redaction is enforced (fails closed if the redaction code cannot load).
- **SQLite opened read-only.** OpenCode and Cursor CLI databases are opened with `file:…?mode=ro` to prevent accidental writes, as a second lock alongside the `{readOnly: true}` option.

## Related

See `src/collectors/security.test.js` for tests covering sensitive data handling.
