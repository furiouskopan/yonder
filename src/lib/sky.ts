// Altitude/azimuth of fixed sky objects (stars, exoplanet hosts, galaxies) from J2000 RA/Dec.
import * as A from "astronomy-engine";

const D2R = Math.PI / 180;

export type SkyFn = (raDeg: number, decDeg: number) => { alt: number; az: number };

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
