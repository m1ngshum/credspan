# Credspan brand assets

**Open proof** is the selected identity: an open C with a separate square representing a proof held independently. The SVG artwork and custom outlined wordmark replace the previous raster arches. The mark expresses ownership and voluntary sharing, not certification or universal issuer trust.

## Narrative

Primary headline: **Your data. Your proof. Your choice.**

People should hold their own credentials and choose what to share. Open standards should let anyone verify those shared proofs without paying a platform for permission. This is a guiding principle, not a claim that all issuers are trusted, private data is public, or infrastructure is free. The current implementation is a local synthetic membership sandbox; it is not a general-purpose holder app or production service.

Secondary tagline: **Open credentials. Built to run.**

## Artwork

- [logo.svg](logo.svg): primary standalone symbol. [logo-dark.svg](logo-dark.svg) uses white and mint on graphite. `logo-black.svg` and `logo-white.svg` are one-colour versions.
- [lockup.svg](lockup.svg): horizontal symbol and outlined wordmark, used by the console. [lockup-dark.svg](lockup-dark.svg) is for dark backgrounds; black and white versions are also supplied.
- [stacked.svg](stacked.svg) and [wordmark.svg](wordmark.svg): stacked and lettering-only masters, each with dark, black and white variants.
- [logo-small.svg](logo-small.svg): slightly enlarged proof square for 16–24 px use. [logo-small-white.svg](logo-small-white.svg) is its reversed counterpart.
- [banner.svg](banner.svg): editable dark banner. Its logo lettering is outlined; the captions use Arial/Helvetica/system sans-serif. [banner.png](banner.png) provides a fixed raster rendering at 1774 × 887.
- [logo.png](logo.png): transparent 1254 × 1254 raster export retained for image consumers. Prefer SVG in interfaces.
- [Console web manifest](../../../apps/console/public/site.webmanifest): favicon SVG/ICO/PNGs, Apple touch and web manifest icons. These assets live in one place, served under `/console/`; manifest icon URLs are relative to that directory. No service worker or offline behaviour is implied.

The symbol and logo lettering consist of vector paths and require no installed font. Captions and interface text remain ordinary text. All artwork is included under the repository's Apache-2.0 license. Designed using the [logo-design skill workflow](https://github.com/kaankiziltug/logo-design-skill); no reference-library marks are included.

## Palette and placement

| Role | HEX | RGB |
|---|---|---|
| Graphite | `#182A32` | 24, 42, 50 |
| Proof teal, on light surfaces | `#007F79` | 0, 127, 121 |
| Mint, on graphite only | `#39D5BE` | 57, 213, 190 |
| Paper | `#F5F7F4` | 245, 247, 244 |

Measured sRGB contrast: graphite/white 14.83:1, teal/white 4.87:1 and mint/graphite 8.08:1. Semantic success and error colours in the console remain distinct from the brand accent.

Keep clear space of at least one proof-square width around the visible mark. Preserve the aspect ratio, square separation and fixed lockup spacing. Prefer the horizontal lockup at 160 px wide or larger, the symbol at 24 px or larger, and the small cut at 16–24 px. Do not stretch, rotate, add effects or place mint on white. Use the supplied dark versions on graphite.

Logo alternative text: “Credspan”. When describing the symbol: “Credspan: an open C with a separate square.” Banner alternative text: “Credspan — Open credentials. Built to run.”

Screen renders, SVG structure and export dimensions are checked. Trademark clearance, physical print matching and native-device certification have not been performed; no Pantone or calibrated CMYK match is claimed.
