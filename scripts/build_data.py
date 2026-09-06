#!/usr/bin/env python3
"""Build the offline datasets in public/data/.

  cities.json     GeoNames cities15000: every place with population >= 15,000
  places.json     GeoNames cities500 minus the above: towns and villages (~200k)
  countries.json  GeoNames countryInfo + capitals
  airports.json   OurAirports: airports, heliports, seaplane bases, airstrips (~70k)

Raw files are downloaded into data/raw/ when missing. Run:  python scripts/build_data.py
"""
import csv
import io
import json
import os
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "public", "data")
GEONAMES = "https://download.geonames.org/export/dump/"
AIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"
CONTINENTS = {"AF": "Africa", "AS": "Asia", "EU": "Europe", "NA": "North America",
              "OC": "Oceania", "SA": "South America", "AN": "Antarctica"}

os.makedirs(RAW, exist_ok=True)
os.makedirs(OUT, exist_ok=True)


def fetch(url: str, name: str) -> str:
    dest = os.path.join(RAW, name)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return dest
    print("downloading", url)
    req = urllib.request.Request(url, headers={"User-Agent": "yonder-data-build"})
    with urllib.request.urlopen(req, timeout=600) as r, open(dest, "wb") as f:
        f.write(r.read())
    return dest


def read_geonames(zip_path: str, txt_name: str):
    """Yield GeoNames rows. Columns: 0 id, 1 name, 2 asciiname, 4 lat, 5 lon,
    7 feature code, 8 country code, 14 population."""
    with zipfile.ZipFile(zip_path) as z, z.open(txt_name) as f:
        for line in io.TextIOWrapper(f, encoding="utf-8"):
            p = line.rstrip("\n").split("\t")
            if len(p) < 15:
                continue
            yield {
                "id": int(p[0]), "name": p[1], "ascii": p[2],
                "lat": float(p[4]), "lon": float(p[5]),
                "fcode": p[7], "cc": p[8], "pop": int(p[14] or 0),
            }


def dump(name: str, payload: dict) -> None:
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {name}: {os.path.getsize(path) / 1e6:.1f} MB")


# ---- countries ---------------------------------------------------------------
countries_raw = {}
with open(fetch(GEONAMES + "countryInfo.txt", "countryInfo.txt"), encoding="utf-8") as f:
    for line in f:
        if line.startswith("#") or not line.strip():
            continue
        p = line.rstrip("\n").split("\t")
        if len(p) < 9:
            continue
        countries_raw[p[0]] = {"cc": p[0], "name": p[4], "capital": p[5],
                               "pop": int(p[7] or 0), "continent": p[8]}

cities500_zip = fetch(GEONAMES + "cities500.zip", "cities500.zip")
cities15000_zip = fetch(GEONAMES + "cities15000.zip", "cities15000.zip")

pplc: dict[str, list] = {}
biggest: dict[str, dict] = {}
all500 = []
for c in read_geonames(cities500_zip, "cities500.txt"):
    all500.append(c)
    if c["fcode"] == "PPLC":
        pplc.setdefault(c["cc"], []).append(c)
    if c["cc"] not in biggest or c["pop"] > biggest[c["cc"]]["pop"]:
        biggest[c["cc"]] = c

countries = []
for cc, info in countries_raw.items():
    cands = pplc.get(cc, [])
    want = info["capital"].strip().lower()
    pick = next((c for c in cands if want and want in (c["name"].lower(), c["ascii"].lower())), None)
    if pick is None and cands:
        pick = max(cands, key=lambda c: c["pop"])
    if pick is None:
        pick = biggest.get(cc)
    if pick is None:
        continue
    countries.append({
        "cc": cc, "name": info["name"], "capital": pick["name"],
        "lat": round(pick["lat"], 4), "lon": round(pick["lon"], 4),
        "pop": info["pop"], "continent": CONTINENTS.get(info["continent"], info["continent"]),
    })
countries.sort(key=lambda x: x["name"])
names = {cc: info["name"] for cc, info in countries_raw.items()}
dump("countries.json", {"source": "GeoNames countryInfo + cities500 (CC BY 4.0)",
                        "names": names, "countries": countries})

# ---- cities (>= 15,000) --------------------------------------------------------
cities = []
big_ids = set()
for c in read_geonames(cities15000_zip, "cities15000.txt"):
    big_ids.add(c["id"])
    cities.append([c["name"], c["cc"], round(c["lat"], 4), round(c["lon"], 4),
                   c["pop"], 1 if c["fcode"] == "PPLC" else 0])
cities.sort(key=lambda x: -x[4])
dump("cities.json", {"source": "GeoNames cities15000 (CC BY 4.0)",
                     "fields": ["name", "cc", "lat", "lon", "pop", "capital"], "rows": cities})

# ---- towns and villages (500 .. 15,000) ------------------------------------------
places = [[c["name"], c["cc"], round(c["lat"], 4), round(c["lon"], 4), c["pop"]]
          for c in all500 if c["id"] not in big_ids]
places.sort(key=lambda x: -x[4])
dump("places.json", {"source": "GeoNames cities500 (CC BY 4.0)",
                     "fields": ["name", "cc", "lat", "lon", "pop"], "rows": places})

# ---- airports ----------------------------------------------------------------------
airports = []
with open(fetch(AIRPORTS_URL, "airports.csv"), encoding="utf-8", newline="") as f:
    for row in csv.DictReader(f):
        if row["type"] == "closed":
            continue
        try:
            lat, lon = float(row["latitude_deg"]), float(row["longitude_deg"])
        except ValueError:
            continue
        airports.append([
            row["name"], row["type"], row.get("iata_code") or "", row.get("icao_code") or row.get("gps_code") or "",
            round(lat, 4), round(lon, 4), row["iso_country"], row.get("municipality") or "",
            1 if row.get("scheduled_service") == "yes" else 0,
        ])
order = {"large_airport": 0, "medium_airport": 1, "small_airport": 2, "seaplane_base": 3, "heliport": 4, "balloonport": 5}
airports.sort(key=lambda a: (order.get(a[1], 9), a[0]))
dump("airports.json", {"source": "OurAirports (public domain)",
                       "fields": ["name", "type", "iata", "icao", "lat", "lon", "cc", "municipality", "scheduled"],
                       "rows": airports})

print(f"cities {len(cities)}  places {len(places)}  countries {len(countries)}  airports {len(airports)}")

# ---- exoplanets (NASA Exoplanet Archive, composite parameters table) ---------------
EXO_URL = ("https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select+pl_name,hostname,sy_dist,disc_year,"
           "discoverymethod,pl_rade,pl_bmasse,pl_orbper,ra,dec,sy_snum,sy_pnum+from+pscomppars"
           "+where+sy_dist+is+not+null&format=csv")
PC_TO_LY = 3.26156


def fnum(v, nd=2):
    try:
        return round(float(v), nd)
    except (TypeError, ValueError):
        return None


exo = []
with open(fetch(EXO_URL, "exoplanets.csv"), encoding="utf-8", newline="") as f:
    for row in csv.DictReader(f):
        pc = fnum(row["sy_dist"], 4)
        if pc is None or pc <= 0:
            continue
        exo.append([row["pl_name"], row["hostname"], round(pc * PC_TO_LY, 2), int(row["disc_year"] or 0),
                    row["discoverymethod"], fnum(row["pl_rade"]), fnum(row["pl_bmasse"]), fnum(row["pl_orbper"], 3),
                    fnum(row["ra"], 4), fnum(row["dec"], 4), int(row["sy_pnum"] or 0)])
exo.sort(key=lambda x: x[2])
dump("exoplanets.json", {"source": "NASA Exoplanet Archive (pscomppars)",
                         "fields": ["name", "host", "ly", "year", "method", "radiusEarth", "massEarth",
                                    "periodDays", "ra", "dec", "planets"], "rows": exo})

# ---- naked-eye stars (HYG v4.1, magnitude <= 6.5 with a known distance) ------------
HYG_URL = "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv"
stars = []
with open(fetch(HYG_URL, "hygdata_v41.csv"), encoding="utf-8", newline="") as f:
    for row in csv.DictReader(f):
        try:
            mag = float(row["mag"])
            dist = float(row["dist"])
        except ValueError:
            continue
        if row["id"] == "0" or mag > 6.5 or dist <= 0 or dist >= 100000:
            continue
        name = row["proper"] or row["bf"] or (f"HIP {row['hip']}" if row["hip"] else
                                              f"HD {row['hd']}" if row["hd"] else f"HYG {row['id']}")
        stars.append([name.strip(), round(float(row["ra"]) * 15, 4), round(float(row["dec"]), 4),
                      round(dist * PC_TO_LY, 1), round(mag, 2), row["con"], row["spect"][:8],
                      1 if row["proper"] else 0])
stars.sort(key=lambda x: x[4])
dump("stars.json", {"source": "HYG database v4.1 (CC BY-SA 4.0)",
                    "fields": ["name", "ra", "dec", "ly", "mag", "con", "spect", "named"], "rows": stars})
print(f"exoplanets {len(exo)}  stars {len(stars)}")
