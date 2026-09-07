#!/usr/bin/env python3
"""Build the offline datasets in public/data/.

  cities.json     GeoNames cities15000: every place with population >= 15,000
  places.json     GeoNames cities500 minus the above: towns and villages (~200k)
  countries.json  GeoNames countryInfo + capitals
  airports.json   OurAirports: airports, heliports, seaplane bases, airstrips (~70k)
  exoplanets.json NASA Exoplanet Archive: confirmed planets with a distance
  stars.json      HYG v4.1: naked-eye stars with a known distance
  deepsky.json    OpenNGC: NGC/IC galaxies, clusters and nebulae with a distance (Messier and
                  famous objects from a curated table, galaxies from their redshift)

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


# ---- deep-sky objects (OpenNGC) ------------------------------------------------------
OPENNGC_URL = "https://raw.githubusercontent.com/mattiaverga/OpenNGC/master/database_files/NGC.csv"
H0, OMEGA_M, OMEGA_L = 70.0, 0.3, 0.7
HUBBLE_TIME_GYR = 977.8 / H0


def light_travel_ly(z: float) -> float:
    """Light-travel distance in light-years for redshift z (flat LambdaCDM), by Simpson integration."""
    n = 200
    h = z / n
    total = 0.0
    for i in range(n + 1):
        zi = i * h
        f = 1.0 / ((1 + zi) * ((OMEGA_M * (1 + zi) ** 3 + OMEGA_L) ** 0.5))
        total += f * (1 if i in (0, n) else 4 if i % 2 else 2)
    return total * h / 3 * HUBBLE_TIME_GYR * 1e9


TYPES = {"G": "Galaxy", "GPair": "Galaxy pair", "GTrpl": "Galaxy triplet", "GGroup": "Galaxy group", "OCl": "Open cluster",
         "GCl": "Globular cluster", "PN": "Planetary nebula", "Neb": "Nebula", "HII": "Emission nebula", "RfN": "Reflection nebula",
         "EmN": "Emission nebula", "Cl+N": "Cluster with nebula", "SNR": "Supernova remnant", "*Ass": "Stellar association"}
GALAXY_TYPES = {"G", "GPair", "GTrpl", "GGroup"}

# Distances in light-years for the Messier objects (literature values, rounded).
MESSIER_LY = {
    1: 6500, 2: 37500, 3: 33900, 4: 7200, 5: 24500, 6: 1600, 7: 980, 8: 4100, 9: 25800, 10: 14300, 11: 6120, 12: 15700, 13: 22200,
    14: 30300, 15: 33600, 16: 7000, 17: 5500, 18: 4900, 19: 28700, 20: 5200, 21: 4250, 22: 10600, 23: 2150, 24: 10000, 25: 2000,
    26: 5000, 27: 1360, 28: 17900, 29: 4000, 30: 27100, 31: 2537000, 32: 2490000, 33: 2730000, 34: 1500, 35: 2800, 36: 4100,
    37: 4500, 38: 4200, 39: 825, 40: 510, 41: 2300, 42: 1344, 43: 1600, 44: 577, 45: 444, 46: 5400, 47: 1600, 48: 1500,
    49: 55900000, 50: 3200, 51: 23000000, 52: 5000, 53: 58000, 54: 87400, 55: 17600, 56: 32900, 57: 2570, 58: 62000000,
    59: 60000000, 60: 55000000, 61: 52500000, 62: 22200, 63: 37000000, 64: 24000000, 65: 35000000, 66: 36000000, 67: 2700,
    68: 33600, 69: 29700, 70: 29400, 71: 12700, 72: 55400, 73: 2500, 74: 32000000, 75: 67500, 76: 2500, 77: 47000000, 78: 1600,
    79: 42100, 80: 32600, 81: 11800000, 82: 11500000, 83: 15000000, 84: 60000000, 85: 60000000, 86: 52000000, 87: 53500000,
    88: 47000000, 89: 50000000, 90: 60000000, 91: 63000000, 92: 26700, 93: 3600, 94: 16000000, 95: 32600000, 96: 31000000,
    97: 2030, 98: 44400000, 99: 50000000, 100: 55000000, 101: 20900000, 102: 50000000, 103: 10000, 104: 31100000, 105: 32000000,
    106: 23700000, 107: 20900, 108: 46000000, 109: 83500000, 110: 2690000,
}
# Well-known non-Messier objects whose distance is not derivable from redshift (light-years).
NAMED_LY = {
    "NGC0104": 15000, "NGC0253": 11400000, "NGC0055": 6500000, "NGC0300": 6000000, "NGC0362": 27700, "NGC0457": 7900, "NGC0663": 6800,
    "NGC0752": 1300, "NGC0869": 7500, "NGC0884": 7500, "NGC0891": 30000000, "NGC1300": 61000000, "NGC1365": 56000000, "NGC1499": 1000,
    "NGC1851": 39500, "NGC2024": 1350, "NGC2070": 160000, "NGC2237": 5200, "NGC2244": 5200, "NGC2264": 2500, "NGC2392": 6500,
    "NGC2403": 8000000, "NGC2516": 1300, "NGC2808": 31000, "NGC3115": 32000000, "NGC3132": 2000, "NGC3242": 1400, "NGC3372": 8500,
    "NGC3532": 1300, "NGC3628": 35000000, "NGC3766": 5500, "NGC4038": 45000000, "NGC4039": 45000000, "NGC4244": 14000000,
    "NGC4449": 12000000, "NGC4565": 40000000, "NGC4631": 25000000, "NGC4755": 6400, "NGC5907": 50000000, "NGC6231": 5600,
    "NGC6302": 3400, "NGC6388": 32000, "NGC6397": 7800, "NGC6543": 3300, "NGC6752": 13000, "NGC6822": 1600000, "NGC6826": 2000,
    "NGC6888": 4700, "NGC6939": 4000, "NGC6946": 25000000, "NGC6960": 2400, "NGC6992": 2400, "NGC7000": 2600, "NGC7009": 2000,
    "NGC7331": 40000000, "NGC7635": 7100, "NGC7662": 2500, "NGC7789": 8000, "IC0405": 1500, "IC0434": 1375, "IC1396": 2400,
    "IC2602": 480, "IC4665": 1400, "IC5146": 3300, "IC0342": 10700000, "IC1613": 2400000, "IC0010": 2200000,
}


def hms_to_deg(s: str) -> float:
    h, m, sec = s.split(":")
    return (int(h) + int(m) / 60 + float(sec) / 3600) * 15


def dms_to_deg(s: str) -> float:
    sign = -1 if s.startswith("-") else 1
    d, m, sec = s.lstrip("+-").split(":")
    return sign * (int(d) + int(m) / 60 + float(sec) / 3600)


def pretty_id(name: str) -> str:
    cat = name[:2] if name.startswith("IC") else name[:3]
    rest = name[len(cat):]
    num = rest.lstrip("0") or "0"
    return f"{cat} {num}"


deep = []
with open(fetch(OPENNGC_URL, "OpenNGC.csv"), encoding="utf-8", newline="") as f:
    for row in csv.DictReader(f, delimiter=";"):
        kind = TYPES.get(row["Type"])
        if not kind or not row["RA"] or not row["Dec"]:
            continue
        name = row["Name"]
        m = int(row["M"]) if row["M"] else 0
        common = row["Common names"].split(",")[0].strip()
        approx = 1
        if m and m in MESSIER_LY:
            ly = MESSIER_LY[m]
        elif name in NAMED_LY:
            ly = NAMED_LY[name]
        elif row["Type"] in GALAXY_TYPES and row["Redshift"] and float(row["Redshift"]) > 0.002:
            ly = light_travel_ly(float(row["Redshift"]))
        else:
            continue
        mag = fnum(row["V-Mag"] or row["B-Mag"], 1)
        label = pretty_id(name)
        if m:
            display = f"Messier {m}" + (f" ({common})" if common else f" ({label})")
            wiki = f"Messier {m}"
        elif common:
            display = f"{common} ({label})"
            wiki = common
        else:
            display = label
            wiki = label
        deep.append([display, kind, round(hms_to_deg(row["RA"]), 4), round(dms_to_deg(row["Dec"]), 4), round(ly), mag, row["Const"], wiki, approx, m, common])
deep.sort(key=lambda r: r[4])
dump("deepsky.json", {"source": "OpenNGC (CC BY-SA 4.0); Messier and named distances curated; galaxy distances from redshift (flat LambdaCDM, H0=70)",
                      "fields": ["name", "kind", "ra", "dec", "ly", "mag", "con", "wiki", "approx", "messier", "common"], "rows": deep})
print(f"deep-sky {len(deep)}")
