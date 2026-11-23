// Maps: pick one with MAP=<name> (default "tempe"). Each has its own footprint, resolution and output folders.
export const MAPS = {
  // downtown Tempe + ASU: Hardy Dr to Rural Rd, Apache Blvd to the north shore of Tempe Town Lake
  tempe: { bbox: { south: 33.4135, west: -111.9505, north: 33.4345, east: -111.9245 }, mpp: 0.15, title: "Downtown Tempe" },
  // the wide corridor: ASU, the rail line past Sky Harbor, downtown Phoenix
  phx: { bbox: { south: 33.405, west: -112.09, north: 33.465, east: -111.9 }, mpp: 0.5, title: "ASU to downtown Phoenix" },
} as const;
export type MapName = keyof typeof MAPS;
export const MAP = (process.env.MAP || "tempe") as MapName;
if (!MAPS[MAP]) throw new Error(`unknown MAP ${MAP}`);
export const BBOX = MAPS[MAP].bbox;
export const MPP = MAPS[MAP].mpp;              // screen metres per pixel at full zoom
export const CENTER = { lat: (BBOX.south + BBOX.north) / 2, lon: (BBOX.west + BBOX.east) / 2 };
export const PITCH_DEG = 45;          // camera elevation; it looks north
export const TILE = 1024;             // DeepZoom tile size
export const CHUNK = 2048;            // render chunk size (pixels)
export const DEPTH_CELL_PX = 4;       // depth grid cell, in full-res pixels

export const DIRS = { data: `data/${MAP}`, out: `out/${MAP}`, pub: `public/maps/${MAP}` };

export const GTFS_KEY = "4f22263f69671d7f49726c3011333e527368211f";   // Valley Metro's published open-data key
export const GTFS_RT = (feed: "vehicles" | "alerts" | "realtime") => `https://mna.mecatran.com/utw/ws/gtfsfeed/${feed}/valleymetro?apiKey=${GTFS_KEY}`;
// adsb.fi open data: 1 request/second; centre on the footprint, radius in nautical miles
export const ADSB_URL = `https://opendata.adsb.fi/api/v2/lat/${CENTER.lat}/lon/${CENTER.lon}/dist/22`;
export const ADSB_FALLBACK = `https://api.adsb.lol/v2/lat/${CENTER.lat}/lon/${CENTER.lon}/dist/22`;
export const GTFS_STATIC = `https://mna.mecatran.com/utw/ws/gtfsfeed/static/valleymetro?apiKey=${GTFS_KEY}`;

// Local tangent plane: metres east / north of CENTER. Phoenix is flat enough that an equirectangular plane is fine here.
const R = 6378137;
export const M_PER_DEG_LAT = (Math.PI / 180) * R;
export const M_PER_DEG_LON = (Math.PI / 180) * R * Math.cos((CENTER.lat * Math.PI) / 180);
export const toEN = (lat: number, lon: number) => ({ e: (lon - CENTER.lon) * M_PER_DEG_LON, n: (lat - CENTER.lat) * M_PER_DEG_LAT });

// Road grammar shared by the renderer and the traffic simulation: lanes decide width, width decides where cars drive.
export const LANE_W = 3.5;
export const ROAD_CLASS: Record<string, { cls: number; lanes: number; sidewalk: number; kph: number }> = {
  motorway: { cls: 0, lanes: 8, sidewalk: 0, kph: 105 }, motorway_link: { cls: 1, lanes: 2, sidewalk: 0, kph: 60 },
  trunk: { cls: 2, lanes: 6, sidewalk: 2.5, kph: 80 }, trunk_link: { cls: 1, lanes: 2, sidewalk: 0, kph: 60 },
  primary: { cls: 3, lanes: 6, sidewalk: 2.5, kph: 65 }, primary_link: { cls: 4, lanes: 2, sidewalk: 1.8, kph: 50 },
  secondary: { cls: 5, lanes: 4, sidewalk: 2.5, kph: 60 }, secondary_link: { cls: 4, lanes: 2, sidewalk: 1.8, kph: 50 },
  tertiary: { cls: 6, lanes: 4, sidewalk: 2.2, kph: 50 }, residential: { cls: 7, lanes: 2, sidewalk: 1.8, kph: 40 },
  unclassified: { cls: 7, lanes: 2, sidewalk: 1.8, kph: 40 }, living_street: { cls: 8, lanes: 2, sidewalk: 1.8, kph: 25 },
  busway: { cls: 6, lanes: 2, sidewalk: 0, kph: 50 }, service: { cls: 9, lanes: 1, sidewalk: 0, kph: 25 },
};
