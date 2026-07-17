# User-supplied route data (`routes.csv`)

When the route APIs are wrong or missing for a flight, add your own corrected
route here. Each row maps a **flight callsign** to its origin/destination.

By default this is the **last** source consulted: adsbdb → airframes.io → this
CSV. Set `ROUTE_CSV_OVERRIDE=true` to make a CSV entry win over the APIs whenever
one exists (useful when an API returns a wrong-but-plausible route the checks
can't catch).

## Callsign to use

Match the **ADS-B/ICAO callsign**, i.e. the 3-letter airline ICAO code plus the
number — e.g. `UAL809`, not the IATA `UA809`. That's the value the app logs for
each aircraft (see the server log lines that mention the callsign), so if you're
unsure, watch the log for the flight and copy the callsign it prints. Matching is
case-insensitive and ignores spaces.

## Columns

Only `callsign` is required. Include coordinates for the destination (and ideally
origin) so distance-to-go and ETA can be computed — without them the route/city
still display, but DTG/ETA stay blank.

| Column | Meaning | Example |
| --- | --- | --- |
| `callsign` | ADS-B/ICAO callsign (**required**) | `UAL809` |
| `airline` | Airline name shown as the big title | `UNITED` |
| `airline_icao` | ICAO airline code (used for logo matching) | `UAL` |
| `origin` | Origin airport code (IATA or ICAO) | `SFO` |
| `origin_city` | Origin city (not currently displayed) | `San Francisco` |
| `origin_country` | Origin country ISO-2 | `US` |
| `origin_lat`,`origin_lon` | Origin coordinates | `37.6213`,`-122.3790` |
| `dest` | Destination airport code (IATA or ICAO) | `MNL` |
| `dest_city` | Destination city (shown on the board) | `Manila` |
| `dest_country` | Destination country ISO-2 (drives the flag) | `PH` |
| `dest_lat`,`dest_lon` | Destination coordinates (needed for DTG/ETA) | `14.5086`,`121.0198` |

Common column aliases are accepted (e.g. `flight`, `from`/`to`,
`destination`, `dest_iata`, `origin_latitude`, …). See `src/routesCsv.js`.

## Applying changes

The CSV is loaded at startup and **reloaded automatically** when it changes (every
~30s, set by `ROUTES_CSV_RESCAN_MS`) — no restart needed. Point `ROUTES_CSV_PATH`
at a different file if you keep it elsewhere.

**In Docker**, mount a host folder onto `/app/data` so you can edit the file from
the host (already configured in `docker-compose.yml`):

```yaml
    volumes:
      - ./data:/app/data
```

Put your `routes.csv` in the `./data` folder next to your compose file. (Mounting
an empty `./data` simply means no corrections are loaded until you add the file.)

The example row shipped here (`UAL809` → SFO–MNL) is just a template — edit or
replace it with your own flights.
