export type DeepSkyKind =
  | "Star"
  | "Star system"
  | "Exoplanet system"
  | "Star cluster"
  | "Nebula"
  | "Black hole"
  | "Galaxy"
  | "Galaxy cluster"
  | "Quasar"
  | "Pulsar"
  | "Cosmic horizon";

export interface DeepSkyObject {
  name: string;
  ly: number; // light-years
  kind: DeepSkyKind;
  note?: string;
  approx?: boolean;
  ra?: number; // J2000, degrees
  dec?: number;
  wiki?: string;
}

// Distances in light-years. Beyond a few billion light-years the "light-travel distance" is used.
export const DEEP_SKY: DeepSkyObject[] = [
  { name: "Proxima Centauri", ly: 4.2465, kind: "Star", note: "Nearest star to the Sun · hosts Proxima b", ra: 217.429, dec: -62.679 },
  { name: "Alpha Centauri A & B", ly: 4.37, kind: "Star system", ra: 219.902, dec: -60.834, wiki: "Alpha Centauri" },
  { name: "Barnard's Star", ly: 5.96, kind: "Star", ra: 269.452, dec: 4.693 },
  { name: "Luhman 16", ly: 6.5, kind: "Star system", note: "Pair of brown dwarfs", ra: 162.328, dec: -53.319 },
  { name: "Wolf 359", ly: 7.86, kind: "Star", ra: 164.121, dec: 7.014 },
  { name: "Lalande 21185", ly: 8.3, kind: "Star", ra: 165.834, dec: 35.97 },
  { name: "Sirius", ly: 8.6, kind: "Star system", note: "Brightest star in the night sky", ra: 101.287, dec: -16.716 },
  { name: "Epsilon Eridani", ly: 10.5, kind: "Star", ra: 53.233, dec: -9.458 },
  { name: "61 Cygni", ly: 11.4, kind: "Star system", ra: 316.725, dec: 38.745 },
  { name: "Procyon", ly: 11.46, kind: "Star system", ra: 114.826, dec: 5.225 },
  { name: "Tau Ceti", ly: 11.9, kind: "Star", ra: 26.017, dec: -15.938 },
  { name: "Altair", ly: 16.7, kind: "Star", ra: 297.696, dec: 8.868 },
  { name: "Vega", ly: 25.04, kind: "Star", ra: 279.235, dec: 38.784 },
  { name: "Fomalhaut", ly: 25.1, kind: "Star", ra: 344.413, dec: -29.622 },
  { name: "Pollux", ly: 33.8, kind: "Star", ra: 116.329, dec: 28.026 },
  { name: "Arcturus", ly: 36.7, kind: "Star", ra: 213.915, dec: 19.182 },
  { name: "TRAPPIST-1", ly: 40.7, kind: "Exoplanet system", note: "Seven Earth-sized planets", ra: 346.622, dec: -5.041 },
  { name: "Capella", ly: 42.9, kind: "Star system", ra: 79.172, dec: 45.998 },
  { name: "51 Pegasi", ly: 50.9, kind: "Exoplanet system", note: "First planet found around a Sun-like star", ra: 344.367, dec: 20.769 },
  { name: "Aldebaran", ly: 65.3, kind: "Star", ra: 68.98, dec: 16.509 },
  { name: "Regulus", ly: 79.3, kind: "Star", ra: 152.093, dec: 11.967 },
  { name: "K2-18", ly: 124, kind: "Exoplanet system", ra: 172.56, dec: 7.588 },
  { name: "Hyades cluster", ly: 153, kind: "Star cluster", ra: 66.75, dec: 15.87, wiki: "Hyades (star cluster)" },
  { name: "Spica", ly: 250, kind: "Star system", ra: 201.298, dec: -11.161 },
  { name: "Polaris", ly: 433, kind: "Star", note: "The North Star", approx: true, ra: 37.955, dec: 89.264 },
  { name: "Pleiades", ly: 444, kind: "Star cluster", ra: 56.75, dec: 24.117 },
  { name: "Betelgeuse", ly: 548, kind: "Star", note: "Red supergiant, future supernova", approx: true, ra: 88.793, dec: 7.407 },
  { name: "Antares", ly: 550, kind: "Star", approx: true, ra: 247.352, dec: -26.432 },
  { name: "Kepler-186", ly: 582, kind: "Exoplanet system", ra: 298.679, dec: 43.955 },
  { name: "Helix Nebula", ly: 655, kind: "Nebula", ra: 337.411, dec: -20.837 },
  { name: "Rigel", ly: 860, kind: "Star", ra: 78.634, dec: -8.202 },
  { name: "Orion Nebula", ly: 1344, kind: "Nebula", ra: 83.822, dec: -5.391 },
  { name: "Kepler-452", ly: 1400, kind: "Exoplanet system", note: "Kepler-452b, 'Earth's cousin'", approx: true, ra: 292.256, dec: 44.277 },
  { name: "Ring Nebula", ly: 2570, kind: "Nebula", ra: 283.396, dec: 33.029 },
  { name: "Deneb", ly: 2615, kind: "Star", approx: true, ra: 310.358, dec: 45.28 },
  { name: "Crab Nebula", ly: 6500, kind: "Nebula", note: "Remnant of the supernova seen in 1054", ra: 83.633, dec: 22.015 },
  { name: "Eagle Nebula (Pillars of Creation)", ly: 7000, kind: "Nebula", ra: 274.7, dec: -13.807, wiki: "Eagle Nebula" },
  { name: "Cygnus X-1", ly: 7200, kind: "Black hole", note: "First black hole ever identified", ra: 299.59, dec: 35.202 },
  { name: "Eta Carinae", ly: 7500, kind: "Star system", ra: 161.265, dec: -59.684 },
  { name: "Omega Centauri", ly: 17090, kind: "Star cluster", ra: 201.697, dec: -47.48 },
  { name: "Sagittarius A*", ly: 26670, kind: "Black hole", note: "Supermassive black hole at the centre of the Milky Way", ra: 266.417, dec: -29.008 },
  { name: "Large Magellanic Cloud", ly: 163000, kind: "Galaxy", ra: 80.894, dec: -69.756 },
  { name: "Small Magellanic Cloud", ly: 200000, kind: "Galaxy", ra: 13.187, dec: -72.829 },
  { name: "Andromeda Galaxy (M31)", ly: 2537000, kind: "Galaxy", note: "Nearest large galaxy, on a collision course with us", ra: 10.685, dec: 41.269, wiki: "Andromeda Galaxy" },
  { name: "Triangulum Galaxy (M33)", ly: 2730000, kind: "Galaxy", ra: 23.462, dec: 30.66, wiki: "Triangulum Galaxy" },
  { name: "Bode's Galaxy (M81)", ly: 11800000, kind: "Galaxy", ra: 148.888, dec: 69.065, wiki: "Messier 81" },
  { name: "Centaurus A", ly: 12000000, kind: "Galaxy", approx: true, ra: 201.365, dec: -43.019 },
  { name: "Pinwheel Galaxy (M101)", ly: 20900000, kind: "Galaxy", ra: 210.802, dec: 54.349, wiki: "Pinwheel Galaxy" },
  { name: "Whirlpool Galaxy (M51)", ly: 23000000, kind: "Galaxy", ra: 202.47, dec: 47.195, wiki: "Whirlpool Galaxy" },
  { name: "Sombrero Galaxy (M104)", ly: 31100000, kind: "Galaxy", ra: 189.998, dec: -11.623, wiki: "Sombrero Galaxy" },
  { name: "Messier 87", ly: 53500000, kind: "Galaxy", note: "Home of the first black hole ever imaged", ra: 187.706, dec: 12.391 },
  { name: "Virgo Cluster", ly: 53800000, kind: "Galaxy cluster", ra: 187.7, dec: 12.4 },
  { name: "Coma Cluster", ly: 321000000, kind: "Galaxy cluster", ra: 194.953, dec: 27.981 },
  { name: "3C 273", ly: 2443000000, kind: "Quasar", note: "Nearest bright quasar", approx: true, ra: 187.278, dec: 2.052 },
  { name: "TON 618", ly: 10400000000, kind: "Quasar", note: "One of the most massive black holes known", approx: true, ra: 188.093, dec: 31.573 },
  { name: "GN-z11", ly: 13400000000, kind: "Galaxy", note: "Light-travel distance; now ~32 billion ly away", approx: true, ra: 189.106, dec: 62.242 },
  { name: "JADES-GS-z14-0", ly: 13500000000, kind: "Galaxy", note: "Most distant confirmed galaxy (2024)", approx: true, ra: 53.083, dec: -27.822 },
  // Pulsars and magnetars (J2000 names encode their coordinates; distances from dispersion measures, so approximate).
  { name: "PSR J0437−4715", ly: 510, kind: "Pulsar", note: "Nearest millisecond pulsar · spins 174 times a second", approx: true, ra: 69.316, dec: -47.253, wiki: "PSR J0437−4715" },
  { name: "Geminga", ly: 815, kind: "Pulsar", note: "Radio-quiet gamma-ray pulsar", approx: true, ra: 98.476, dec: 17.771 },
  { name: "Vela Pulsar", ly: 960, kind: "Pulsar", note: "Brightest pulsar at radio wavelengths · 11 rotations a second", approx: true, ra: 128.836, dec: -45.176 },
  { name: "PSR B1919+21", ly: 1000, kind: "Pulsar", note: "The first pulsar ever discovered (1967)", approx: true, ra: 290.255, dec: 21.897, wiki: "PSR B1919+21" },
  { name: "PSR B1257+12 (Lich)", ly: 2300, kind: "Pulsar", note: "Hosts the first exoplanets ever found (1992)", approx: true, ra: 195.013, dec: 12.682, wiki: "PSR B1257+12" },
  { name: "PSR B0329+54", ly: 3300, kind: "Pulsar", note: "One of the brightest northern pulsars", approx: true, ra: 53.248, dec: 54.579, wiki: "PSR B0329+54" },
  { name: "PSR J0737−3039 (Double Pulsar)", ly: 3500, kind: "Pulsar", note: "The only known pair of pulsars orbiting each other", approx: true, ra: 114.464, dec: -30.661, wiki: "PSR J0737−3039" },
  { name: "Crab Pulsar", ly: 6500, kind: "Pulsar", note: "Neutron star at the heart of the Crab Nebula · 30 rotations a second", approx: true, ra: 83.633, dec: 22.015 },
  { name: "Black Widow Pulsar", ly: 6500, kind: "Pulsar", note: "Evaporating its companion star", approx: true, ra: 299.903, dec: 20.804, wiki: "Black Widow Pulsar" },
  { name: "PSR J1748−2446ad", ly: 18000, kind: "Pulsar", note: "Fastest-spinning pulsar known · 716 rotations a second", approx: true, ra: 267.021, dec: -24.78, wiki: "PSR J1748−2446ad" },
  { name: "Hulse–Taylor pulsar (PSR B1913+16)", ly: 21000, kind: "Pulsar", note: "First binary pulsar · indirect proof of gravitational waves", approx: true, ra: 288.867, dec: 16.107, wiki: "Hulse–Taylor pulsar" },
  { name: "SGR 1806−20", ly: 50000, kind: "Pulsar", note: "Magnetar · its 2004 flare was the brightest ever seen from outside the Solar System", approx: true, ra: 272.164, dec: -20.411, wiki: "SGR 1806−20" },
  // Quasars and blazars (light-travel distances from redshift, flat ΛCDM with H0 = 70).
  { name: "Markarian 421", ly: 420000000, kind: "Quasar", note: "Blazar · one of the nearest, a bright gamma-ray source", approx: true, ra: 166.114, dec: 38.209 },
  { name: "Markarian 501", ly: 460000000, kind: "Quasar", note: "Blazar · TeV gamma rays", approx: true, ra: 253.468, dec: 39.76 },
  { name: "OJ 287", ly: 3500000000, kind: "Quasar", note: "Blazar with a 12-year cycle from a binary black hole", approx: true, ra: 133.704, dec: 20.109 },
  { name: "3C 48", ly: 4000000000, kind: "Quasar", note: "First quasar to be identified (1960)", approx: true, ra: 24.422, dec: 33.16 },
  { name: "3C 279", ly: 5300000000, kind: "Quasar", note: "Blazar with a jet that appears to move faster than light", approx: true, ra: 194.047, dec: -5.789 },
  { name: "S5 0014+81", ly: 11700000000, kind: "Quasar", note: "Powered by a 40-billion-solar-mass black hole", approx: true, ra: 4.285, dec: 81.586 },
  { name: "APM 08279+5255", ly: 12000000000, kind: "Quasar", note: "Gravitationally lensed · hosts a vast reservoir of water vapour", approx: true, ra: 127.924, dec: 52.755 },
  { name: "ULAS J1342+0928", ly: 13100000000, kind: "Quasar", note: "One of the most distant quasars known, seen 690 million years after the Big Bang", approx: true, ra: 205.534, dec: 9.478 },
  { name: "Edge of the observable universe", ly: 46500000000, kind: "Cosmic horizon", note: "Comoving distance to the cosmic horizon", approx: true, wiki: "Observable universe" },
];

/** Regions of the Solar System, given as distance from the Sun in AU (from Earth it varies by ±1 AU). */
export const SOLAR_REGIONS: { name: string; au: number; note: string; wiki: string }[] = [
  { name: "Asteroid belt (middle)", au: 2.7, note: "Between Mars and Jupiter", wiki: "Asteroid belt" },
  { name: "Kuiper belt (inner edge)", au: 30, note: "Icy bodies beyond Neptune", wiki: "Kuiper belt" },
  { name: "Heliopause", au: 120, note: "Where the solar wind meets interstellar space", wiki: "Heliosphere" },
  { name: "Inner Oort cloud", au: 2000, note: "Hypothesised comet reservoir", wiki: "Oort cloud" },
  { name: "Outer Oort cloud", au: 100000, note: "The Sun's gravitational edge, about 1.6 light-years", wiki: "Oort cloud" },
];
