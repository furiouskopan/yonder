export type Category =
  | "city"
  | "town"
  | "capital"
  | "landmark"
  | "poi"
  | "airport"
  | "custom"
  | "aircraft"
  | "ship"
  | "train"
  | "satellite"
  | "solar"
  | "probe"
  | "exoplanet"
  | "star";

export type Realm = "earth" | "air" | "space";

export interface CategoryInfo {
  id: Category;
  label: string;
  color: string;
  realm: Realm;
}

export const CATEGORIES: CategoryInfo[] = [
  { id: "city", label: "Cities", color: "#3b82f6", realm: "earth" },
  { id: "town", label: "Towns & villages", color: "#60a5fa", realm: "earth" },
  { id: "capital", label: "Capitals", color: "#6366f1", realm: "earth" },
  { id: "landmark", label: "Landmarks", color: "#10b981", realm: "earth" },
  { id: "poi", label: "Nearby places", color: "#14b8a6", realm: "earth" },
  { id: "airport", label: "Airports", color: "#8b5cf6", realm: "earth" },
  { id: "custom", label: "My places", color: "#f59e0b", realm: "earth" },
  { id: "aircraft", label: "Aircraft", color: "#eab308", realm: "air" },
  { id: "ship", label: "Ships", color: "#0ea5e9", realm: "earth" },
  { id: "train", label: "Trains", color: "#84cc16", realm: "earth" },
  { id: "satellite", label: "Satellites", color: "#06b6d4", realm: "space" },
  { id: "solar", label: "Solar system", color: "#f97316", realm: "space" },
  { id: "probe", label: "Spacecraft", color: "#ec4899", realm: "space" },
  { id: "exoplanet", label: "Exoplanets", color: "#d946ef", realm: "space" },
  { id: "star", label: "Stars & galaxies", color: "#a855f7", realm: "space" },
];

export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c])) as Record<Category, CategoryInfo>;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Origin {
  lat: number;
  lon: number;
  name: string;
  alt?: number; // metres above sea level
}

export interface Target {
  id: string;
  name: string;
  category: Category;
  subtitle?: string;
  key?: string; // normalised search text
  distanceKm: number; // NaN while unknown
  rateKms?: number; // change of distance, km/s (negative = approaching)
  // Earth surface or aircraft ground position
  lat?: number;
  lon?: number;
  heightKm?: number; // aircraft / satellite altitude above the surface
  // Topocentric look angles for things in the sky
  altDeg?: number;
  azDeg?: number;
  subLat?: number; // satellite ground point
  subLon?: number;
  ra?: number; // J2000 right ascension, degrees (fixed sky objects)
  dec?: number;
  heading?: number; // aircraft track, degrees
  speedKms?: number;
  helio?: Vec3; // heliocentric ecliptic J2000 position, AU
  parent?: string; // moons: the body they orbit
  rel?: Vec3; // moons: offset from the parent, ecliptic J2000, AU
  mag?: number; // apparent magnitude (stars, deep-sky objects)
  approx?: boolean;
  note?: string;
  pop?: number; // population; formatted on demand (see lib/target.ts noteOf)
  kind?: string;
  wiki?: string; // Wikipedia hint: a title, "lang:Title" or "wikidata:Q..."
  wiki2?: string; // fallback query
  facts?: [string, string][]; // extra label/value pairs for the detail panel
}

export interface CustomPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  note?: string;
}

export type SortKey = "distance" | "name";

export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}
