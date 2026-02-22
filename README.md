# st-hk-bridge

Standalone SmartThings-to-HomeKit bridge for one lock device, tested with a Schlage zigbee lock specifically. The goal of this project is to provide a simple, standalone server to connect the device, without the additional complexity of other multi-purpose products.

## What it does

- Exposes one HomeKit `LockMechanism` accessory on your LAN.
- Reads lock status from SmartThings: `GET /v1/devices/{deviceId}/status`.
- Sends lock/unlock commands to SmartThings: `POST /v1/devices/{deviceId}/commands`.
- Polls SmartThings every 30 seconds by default (`POLL_INTERVAL_SECONDS`).
- After a successful lock/unlock command, temporarily polls every 5 seconds for 15 seconds by default, and exits early if the expected state is observed.
- If the expected state is never observed, transition is timed out after 30 seconds by default and target state is reset to current observed state.
- Uses confirm-only command behavior: HomeKit command succeeds only after SmartThings command request succeeds.
- Tolerates transient polling failures and only marks lock state `Unknown` after a configurable outage threshold.
- Persists the last known `locked`/`unlocked` state in `DATA_DIR` and restores it on restart.

## Requirements

- Node.js 20+
- SmartThings personal access token
- SmartThings lock device ID
- Apple Home hub/Home app environment that supports third-party HomeKit accessories on LAN
- Linux/NAS host for Docker deployment (`network_mode: host` recommended for mDNS)

## Configuration

Required:

- `SMARTTHINGS_TOKEN` (you can get this on the Smartthings developer site)
- `SMARTTHINGS_DEVICE_ID` (see below)
- `HOMEKIT_BRIDGE_NAME` (anything, e.g. "Front Door Lock")
- `HOMEKIT_USERNAME` (format `AA:BB:CC:DD:EE:FF`, can be anything as long as it's in that format)
- `HOMEKIT_SETUP_CODE` (format `123-45-678`)

Optional:

- `POLL_INTERVAL_SECONDS` (default `30`)
- `COMMAND_BURST_POLL_INTERVAL_SECONDS` (default `5`)
- `COMMAND_BURST_DURATION_SECONDS` (default `15`)
- `TRANSITION_TIMEOUT_SECONDS` (default `30`)
- `POLL_FAILURES_BEFORE_UNKNOWN` (default `3`)
- `POLL_FAILURE_GRACE_SECONDS` (default `90`)
- `SMARTTHINGS_REQUEST_TIMEOUT_SECONDS` (default `15`)
- `SMARTTHINGS_MAX_REQUESTS_PER_MINUTE` (default `10`)
- `SMARTTHINGS_API_BASE` (default `https://api.smartthings.com/v1`)
- `HOMEKIT_PORT` (default `51826`)
- `HOMEKIT_AUTO_BIND` (default `true`) auto-selects a LAN interface when `HOMEKIT_BIND` is empty
- `HOMEKIT_BIND` (default empty) explicit interface/address list, comma-separated (example `eno1` or `en0,eno1`)
- `HOMEKIT_ADVERTISER` (default `ciao`) one of `ciao`, `bonjour-hap`, `avahi`, `resolved`
- `DATA_DIR` (default `/data`)
- `LOG_LEVEL` (default `info`)
- `HEALTH_PORT` (default `8080`)

## Get your lock device ID

```bash
curl -sS https://api.smartthings.com/v1/devices \
  -H "Authorization: Bearer ${SMARTTHINGS_TOKEN}" \
  | jq -r '.items[] | [.label, .deviceId] | @tsv'
```

## Local run

```bash
npm install
npm run build
SMARTTHINGS_TOKEN="..." \
SMARTTHINGS_DEVICE_ID="..." \
HOMEKIT_BRIDGE_NAME="Front Door Lock" \
HOMEKIT_USERNAME="AA:BB:CC:DD:EE:FF" \
HOMEKIT_SETUP_CODE="123-45-678" \
DATA_DIR="./data" \
npm start
```

## Docker run

```bash
cp docker-compose.example.yml docker-compose.yml
# edit env values in docker-compose.yml
docker compose up -d
```

## Ubuntu Docker HomeKit Reachability

If the bridge appears in Apple Home but add/pair fails with `destination unreachable`, the HAP endpoint is
usually being advertised on an interface Apple devices cannot route to.

Requirements:

- Keep `network_mode: host`.
- Ensure LAN reachability to `HOMEKIT_PORT` (TCP).
- Ensure mDNS multicast path on UDP `5353`.

Validation on Ubuntu host:

```bash
avahi-browse -rt _hap._tcp
ss -lntup | grep "${HOMEKIT_PORT:-51826}"
```

Validation from another LAN device:

```bash
nc -vz <ubuntu_lan_ip> <HOMEKIT_PORT>
```

Override examples:

- `HOMEKIT_BIND=eno1` (Ubuntu)
- `HOMEKIT_BIND=en0` (macOS)
- `HOMEKIT_BIND=en0,eno1` (shared env across hosts)

Advertiser fallback:

- If `ciao` still fails in your environment, set `HOMEKIT_ADVERTISER=bonjour-hap` and restart.

## Docker Deployment (Linux x86 Server)

Build an image on a Mac with Apple Silicon for a Linux x86_64 (`linux/amd64`) server:

```bash
docker buildx build --platform linux/amd64 -t st-hk-bridge:latest --load .
```

To stream image directly to a remote server without using a registry:

```bash
docker save st-hk-bridge:latest | gzip | ssh <servername> 'gunzip | docker load'
```


## Pairing in Apple Home

1. Open Apple Home.
2. Add Accessory.
3. Enter `HOMEKIT_SETUP_CODE`.
4. Assign room/name.

If you need to fully reset pairing identity, stop the service and delete the persistent `data` directory.

## Health endpoint

`GET http://<bridge-host>:8080/healthz`

Response fields:

- `status`: `ok` or `degraded`
- `currentMappedState`: `locked` / `unlocked` / `unknown`
- `lastSuccessfulPollAt`: ISO timestamp or `null`
- `lastPollError`: string or `null`

## Tests

```bash
npm test
```

## Notes

- SmartThings device API rate limit is 12 requests/minute per device. This bridge defaults to `SMARTTHINGS_MAX_REQUESTS_PER_MINUTE=10` and will delay requests when needed to stay within that budget.
- Default polling is 2 requests/minute, and each command burst adds up to 2-3 extra status polls in the short burst window.
- For Docker deployments on Linux/NAS, host networking improves HomeKit discovery reliability.
- No internet exposure is required; HomeKit traffic should remain LAN-local while still allowing local reachability to `HOMEKIT_PORT` and mDNS (UDP `5353`).
