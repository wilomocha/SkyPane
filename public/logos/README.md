# Airline logos

Drop airline logo image files here to have them shown on the board instead of the
generic drawn globe. Airline logos are trademarked, so none are bundled — add your
own (or ones you have the rights to use).

## Naming

Name each file by the airline's **ICAO callsign code** (preferred), its name, or
IATA-style slug. The server matches, case-insensitively:

- `UAL.png`  → United Airlines (ICAO "UAL")
- `DAL.svg`  → Delta (ICAO "DAL")
- `AAL.png`  → American (ICAO "AAL")
- `united.png` → matched by name (lowercased, non-alphanumerics removed)

Supported extensions (priority order): `svg`, `png`, `webp`, `jpg`, `jpeg`, `gif`.

Transparent PNG or SVG works best — the image is drawn into a square emblem area
and then dotted by the LED grid to match the board's look.

## Applying changes

Logos are indexed at startup and **re-scanned automatically** (every ~30s, set by
`LOGO_RESCAN_MS`), so a file you drop in here appears on the board within about
half a minute — no restart needed.

### Running in Docker

Inside a container this folder lives in the image, so mount a host folder onto it
and drop your logos there. In `docker-compose.yml` (already configured):

```yaml
    volumes:
      - ./logos:/app/public/logos
```

Then put `UAL.png`, `SWA.png`, … in the `./logos` folder next to your compose
file. They're picked up automatically (no `docker restart` required).

## Optional: remote logo source

Instead of (or in addition to) local files, set `AIRLINE_LOGO_URL_TEMPLATE` to a
URL containing `{icao}` and/or `{name}` placeholders — e.g. a logo CDN you have
rights to use. Local files take priority; the remote template is the fallback.
Left unset by default so nothing external is loaded without opt-in.
