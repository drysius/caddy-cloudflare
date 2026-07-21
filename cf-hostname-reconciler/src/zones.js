// Zone discovery and target-zone resolution, with a short cache.
import { CloudflareError } from "./cloudflare.js";
import { log } from "./logging.js";

export class ZoneRegistry {
  constructor(client, names = [], ttlSeconds = 900, now = () => Date.now()) {
    this._client = client;
    this._names = names;
    this._ttl = ttlSeconds * 1000;
    this._now = now;
    this._zones = [];
    this._fetchedAt = 0;
  }

  async zones(force = false) {
    if (force || this._zones.length === 0 || this._now() - this._fetchedAt > this._ttl) {
      const zones = await this._client.listZones(this._names);
      if (!zones.length) throw new CloudflareError("token can see no zones; check its Zone:Read permission");
      // CF_DOMAINS order is meaningful (first = default target); keep it. Otherwise sort.
      this._zones = this._names.length ? zones : [...zones].sort((a, b) => a.name.localeCompare(b.name));
      this._fetchedAt = this._now();
      log.info("zones discovered", { zones: this._zones.map((z) => z.name) });
    }
    return this._zones;
  }

  async zoneNames() {
    return (await this.zones()).map((z) => z.name);
  }

  async byName(name) {
    const wanted = name.trim().toLowerCase();
    return (await this.zones()).find((z) => z.name === wanted) ?? null;
  }

  // Zone that should own a newly created custom hostname.
  // Order: container `cf_zone` hint -> first CF_DOMAINS entry -> the single known zone.
  async targetZone(hint = "") {
    if (hint) {
      const zone = await this.byName(hint);
      if (zone) return zone;
      throw new CloudflareError(`target zone ${JSON.stringify(hint)} is not among the managed zones`);
    }
    const zones = await this.zones();
    if (this._names.length || zones.length === 1) return zones[0];
    throw new CloudflareError(
      "multiple zones are managed but no target zone was given; set CF_DOMAINS or add a `cf_zone` label to the container",
    );
  }
}
