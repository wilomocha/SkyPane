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

Logos are indexed when the server starts, so **restart the server** after adding
or renaming files.

## Optional: remote logo source

Instead of (or in addition to) local files, set `AIRLINE_LOGO_URL_TEMPLATE` to a
URL containing `{icao}` and/or `{name}` placeholders — e.g. a logo CDN you have
rights to use. Local files take priority; the remote template is the fallback.
Left unset by default so nothing external is loaded without opt-in.
