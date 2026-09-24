# Take-home: 200 messages from the forecourt

Pure-IN runs fuel stations around Jeddah. At every station, a controller reports each pump sale and each
tank reading to our server as JSON. This folder holds about 200 of those messages from four stations over
three days.

All of the data is invented, but it's shaped like the real thing, problems included.

## The files

**`messages.json`** holds everything the server received, in the order it arrived. Each item is one delivery
from one controller:

```json
{
  "PtsId": "the controller's serial number",
  "Protocol": "jsonPTS",
  "Packets": [ { "Id": 1, "Type": "UploadPumpTransaction", "Data": { } } ]
}
```

A delivery carries one or more packets, of two types:

- **`UploadPumpTransaction`**: one sale. `Pump`, `Nozzle`, `Transaction` (the controller's number for the
  sale), `FuelGradeName`, `Volume` (litres), `Price` (SAR per litre), `Amount` (SAR charged) and `DateTime`
  (when the sale finished, by the controller's own clock).
- **`ProbeMeasurements`**: one tank reading. `Probe`, `DateTime`, `ProductVolume` (litres in the tank) and a
  few more fields.

**`stations.json`** lists the controllers we've registered: which station each one is at, and
`utc_offset_minutes`, the offset of that controller's clock from UTC.

## The task

1. Create PostgreSQL tables for the messages.
2. Write a loader, in any language. Running it a second time must change nothing.
3. Produce daily sales per station, in litres and SAR, grouped by the Riyadh calendar day.
4. In your README, explain how to run it, anything in the data you wouldn't trust, and what you did about it.

## How it works

- Plan on 3–4 hours, and please don't spend more. We care about how you think, not polish.
- AI tools (Claude Code, Codex or anything else) are allowed and expected. If you can, include the prompts
  you used.
- Any recent version of PostgreSQL is fine, installed locally or in Docker.
- Send back a link to a GitHub repository. If it's private, invite `m7mdshesha`.
- Afterwards we'll have a 60-minute call where you run it and walk us through it.
