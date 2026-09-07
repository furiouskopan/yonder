// Altitude/azimuth of fixed sky objects (stars, exoplanet hosts, galaxies) from J2000 RA/Dec.
import * as A from "astronomy-engine";

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export type SkyFn = (raDeg: number, decDeg: number) => { alt: number; az: number };

/** Exact (precession, nutation, refraction) conversion; a few microseconds per call. Use for single objects. */
export function makeSky(time: A.AstroTime, observer: A.Observer): SkyFn {
  const rot = A.Rotation_EQJ_EQD(time);
  return (raDeg, decDeg) => {
    const ra = raDeg * D2R;
    const dec = decDeg * D2R;
    const v = new A.Vector(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec), time);
    const eq = A.EquatorFromVector(A.RotateVector(rot, v));
    const hz = A.Horizon(time, observer, eq.ra, eq.dec, "normal");
    return { alt: hz.altitude, az: hz.azimuth };
  };
}

/**
 * Fast spherical-trigonometry frame for drawing thousands of stars per second. Ignores precession
 * since J2000 and refraction (under half a degree), which is fine for a planetarium chart.
 */
export class SkyFrame {
  readonly lst: number; // local sidereal angle, radians
  readonly sinLat: number;
  readonly cosLat: number;

  constructor(time: A.AstroTime, latDeg: number, lonDeg: number) {
    this.lst = (A.SiderealTime(time) * 15 + lonDeg) * D2R;
    this.sinLat = Math.sin(latDeg * D2R);
    this.cosLat = Math.cos(latDeg * D2R);
  }

  /** Sine of the altitude only, for quick "is it up" tests. */
  sinAlt(raRad: number, sinDec: number, cosDec: number): number {
    return this.sinLat * sinDec + this.cosLat * cosDec * Math.cos(this.lst - raRad);
  }

  /** Altitude and azimuth in degrees (azimuth clockwise from north). */
  altAz(raRad: number, sinDec: number, cosDec: number): { alt: number; az: number } {
    const h = this.lst - raRad;
    const cosH = Math.cos(h);
    const up = this.sinLat * sinDec + this.cosLat * cosDec * cosH;
    const north = this.cosLat * sinDec - this.sinLat * cosDec * cosH;
    const east = -cosDec * Math.sin(h);
    return { alt: Math.asin(Math.max(-1, Math.min(1, up))) * R2D, az: (Math.atan2(east, north) * R2D + 360) % 360 };
  }
}
