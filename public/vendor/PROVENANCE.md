# Vendored third-party assets

| Field | Value |
|---|---|
| Library | Chart.js |
| Version | 4.5.1 |
| File | `public/vendor/chart.umd.min.js` (UMD build, `dist/chart.umd.min.js` in the package) |
| Source | `https://registry.npmjs.org/chart.js/-/chart.js-4.5.1.tgz` (fetched 2026-09-20) |
| Tarball sha1 | `19dd1a9a386a3f6397691672231cb5fc9c052c35` — matches the registry's `dist.shasum` |
| Tarball sha512 | `GIjfiT9dbmHRiYi6Nl2yFCq7kkwdkp1W/lp2J99rX0yo9tgJGn3lKQATztIjb5tVtevcBtIdICNWqlq5+E8/Pw==` — matches the registry's `dist.integrity` |
| Extracted file sha256 | `48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a` |
| Size | 208,522 bytes |
| Licence | MIT — `public/vendor/chart.js.LICENSE.md`, copied from the same tarball |

| ID | Fact | Why it matters |
|---|---|---|
| V-1 | The file is BYTE-IDENTICAL to the upstream `dist/chart.umd.min.js`. Nothing was stripped or reformatted. | The sha256 above is verifiable against the published tarball; edit the file and that stops being true. |
| V-2 | Not an npm dependency. Chart.js is not in `package.json`; the bundle is committed and served from `/vendor/`. | `npx session-rx` must work offline with no install step (DIS-001, GATE-OFFLINE). |
| V-3 | The bundle makes NO network call. Its only two `https://` strings are inside `/*! */` banner comments (`https://www.chartjs.org`, `https://github.com/kurkle/color#readme`). Asserted by `tests/frontend-contract.test.js`. | GATE-OFFLINE is about runtime fetches, and a URL in a comment is not one — but it has to be proven, not assumed. |
| V-4 | `@kurkle/color`, Chart.js's only dependency, is bundled inside this UMD file. Nothing else is required at runtime. | No second vendored file, no module resolution in the browser. |
| V-5 | `chart.umd.min.js.map` is deliberately NOT vendored (967,673 bytes, ~4.6x the bundle). | Stated gap: with devtools open the browser requests `/vendor/chart.umd.min.js.map` and gets a local 404. No remote request, no console error in normal use. Vendor the map if third-party stack traces are ever needed. |

## Re-verifying this by hand

```bash
curl -sL -o /tmp/chart.tgz https://registry.npmjs.org/chart.js/-/chart.js-4.5.1.tgz
shasum -a 1 /tmp/chart.tgz                      # expect 19dd1a9a...2c35
tar -xzOf /tmp/chart.tgz package/dist/chart.umd.min.js | shasum -a 256
#                                               # expect 48444a82...f54a
shasum -a 256 public/vendor/chart.umd.min.js    # must be the same
```
