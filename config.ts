// The footprint: ASU Tempe and its surroundings, the Valley Metro Rail corridor along Washington St past Sky Harbor,
// and downtown Phoenix to the 1st Ave / Jefferson stations.
export const BBOX = { south: 33.405, west: -112.09, north: 33.465, east: -111.9 };
export const CENTER = { lat: (BBOX.south + BBOX.north) / 2, lon: (BBOX.west + BBOX.east) / 2 };
export const PITCH_DEG = 45;          // camera elevation; it looks north
export const MPP = 0.5;               // screen metres per pixel at full zoom
export const TILE = 1024;             // DeepZoom tile size
export const CHUNK = 2048;            // render chunk size (pixels)
export const DEPTH_CELL_PX = 4;       // depth grid cell, in full-res pixels (2 m at MPP 0.5)

export const GTFS_KEY = "4f22263f69671d7f49726c3011333e527368211f";   // Valley Metro's published open-data key
export const GTFS_RT = (feed: "vehicles" | "alerts") => `https://mna.mecatran.com/utw/ws/gtfsfeed/${feed}/valleymetro?apiKey=${GTFS_KEY}`;
export const GTFS_STATIC = `https://mna.mecatran.com/utw/ws/gtfsfeed/static/valleymetro?apiKey=${GTFS_KEY}`;

// Local tangent plane: metres east / north of CENTER. Phoenix is flat enough that an equirectangular plane is fine here.
const R = 6378137;
export const M_PER_DEG_LAT = (Math.PI / 180) * R;
export const M_PER_DEG_LON = (Math.PI / 180) * R * Math.cos((CENTER.lat * Math.PI) / 180);
export const toEN = (lat: number, lon: number) => ({ e: (lon - CENTER.lon) * M_PER_DEG_LON, n: (lat - CENTER.lat) * M_PER_DEG_LAT });
