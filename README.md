# st-hk-bridge

Standalone SmartThings-to-HomeKit bridge for one lock device.

## What it does

- Exposes one HomeKit `LockMechanism` accessory on your LAN.
- Reads lock status from SmartThings: `GET /v1/devices/{deviceId}/status`.
- Sends lock/unlock commands to SmartThings: `POST /v1/devices/{deviceId}/commands`.
- Polls SmartThings every 30 seconds by default (`POLL_INTERVAL_SECONDS`).
- After a successful lock/unlock command, temporarily polls every 5 seconds for 15 seconds by default, and exits early if the expected state is observed.
- If the expected state is never observed, transition is timed out after 30 seconds by default and target state is reset to current observed state.
- Uses confirm-only command behavior: HomeKit command succeeds only after SmartThings command request succeeds.
- Marks current lock state as `Unknown` immediately if status polling fails.

## Requirements

- Node.js 20+
- SmartThings personal access token
- SmartThings lock device ID
- Apple Home hub/Home app environment that supports third-party HomeKit accessories on LAN
- Linux/NAS host for Docker deployment (`network_mode: host` recommended for mDNS)

## Configuration

Required:

- `SMARTTHINGS_TOKEN`
- `SMARTTHINGS_DEVICE_ID`
- `HOMEKIT_BRIDGE_NAME`
- `HOMEKIT_USERNAME` (format `AA:BB:CC:DD:EE:FF`)
- `HOMEKIT_SETUP_CODE` (format `123-45-678`)

Optional:

- `POLL_INTERVAL_SECONDS` (default `30`)
- `COMMAND_BURST_POLL_INTERVAL_SECONDS` (default `5`)
- `COMMAND_BURST_DURATION_SECONDS` (default `15`)
- `TRANSITION_TIMEOUT_SECONDS` (default `30`)
- `SMARTTHINGS_API_BASE` (default `https://api.smartthings.com/v1`)
- `HOMEKIT_PORT` (default `51826`)
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
docker compose up -d --build
```

## Docker Deployment (Linux x86 Server)

Build an image for a Linux x86_64 (`linux/amd64`) server:

```bash
docker buildx build --platform linux/amd64 -t st-hk-bridge:latest -t st-hk-bridge:$(git rev-parse --short HEAD) --load .
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

- SmartThings device API rate limit is 12 requests/minute per device. The default 30 second polling interval is 2 requests/minute, and each command burst adds up to 2-3 extra status polls.
- For Docker deployments on Linux/NAS, host networking improves HomeKit discovery reliability.
