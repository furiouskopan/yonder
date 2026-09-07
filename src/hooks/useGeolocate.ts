import { useCallback, useState } from "react";

/** Browser geolocation with a one-line status message; `locate()` calls back with the fix. */
export function useGeolocate(onFix: (lat: number, lon: number) => void): { locate: () => void; busy: boolean; message: string | null } {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const locate = useCallback(() => {
    if (!navigator.geolocation) {
      setMessage("Geolocation is not available in this browser");
      return;
    }
    if (!window.isSecureContext) {
      setMessage("Location needs a secure page (https or localhost)");
      return;
    }
    setBusy(true);
    setMessage("Locating…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false);
        setMessage(null);
        onFix(pos.coords.latitude, pos.coords.longitude);
      },
      (err) => {
        setBusy(false);
        setMessage(err.code === err.PERMISSION_DENIED ? "Location permission was denied" : err.message);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  }, [onFix]);
  return { locate, busy, message };
}
