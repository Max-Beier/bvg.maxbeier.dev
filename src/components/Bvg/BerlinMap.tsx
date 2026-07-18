import L, { icon, LatLng } from "leaflet";
import "leaflet/dist/leaflet.css";
import { onCleanup, onMount } from "solid-js";

interface State {
  tripId: string;
  marker: L.Marker;
  lineProduct: string;
  lineName: string;
  direction: string;
  polyline: LatLng[];
  frameTimes: number[];
  progress: number;
  speed: number;
  lerping: boolean;
  lerpStart: number;
  lerpFromLat: number;
  lerpFromLng: number;
  lerpToLat: number;
  lerpToLng: number;
  apiProgress: number;
  trail: L.Polyline | null;
}

const LERP_MS = 1000;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const PRODUCT_COLORS: Record<string, string> = {
  subway: "#003d7a",
  suburban: "#c6af00",
  tram: "#8c1d40",
  bus: "#008a3c",
  ferry: "#a336b5",
  express: "#009640",
  regional: "#404040",
};

const TILE_LAYERS = {
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  light:
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
};

const TILE_ATTR =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>';

type MapStyle = "dark" | "light";

const BerlinMap = () => {
  let mapInstance!: L.Map;
  const states = new Map<string, State>();
  let rafId: number | null = null;
  const iconCache = new Map<string, L.Icon>();
  let currentStyle: MapStyle = "dark";
  let tileLayer!: L.TileLayer;

  const getIcon = (product: string, name: string) => {
    const key = `${product}/${name}`;
    const c = iconCache.get(key);
    if (c) return c;
    let url: string;
    switch (product) {
      case "bus":
        url = "img/icons/bvg/bus.svg";
        break;
      case "ferry":
        url = "img/icons/bvg/ferry.svg";
        break;
      case "express":
        url = "img/icons/bvg/express.svg";
        break;
      case "regional":
        url = "img/icons/bvg/regional.svg";
        break;
      default:
        url = `img/icons/bvg/${product}/${name}.svg`;
    }
    const i = icon({
      iconUrl: url,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -12],
    });
    iconCache.set(key, i);
    return i;
  };

  const getTrailColor = (product: string): string => {
    return PRODUCT_COLORS[product] || "#888888";
  };

  const posAt = (pts: LatLng[], times: number[], p: number): LatLng | null => {
    if (pts.length < 2 || times.length < 2) return null;
    const t = Math.max(0, Math.min(1, p));
    const pt = times[0] + (times[times.length - 1] - times[0]) * t;
    let k = 0;
    while (k < times.length - 1 && times[k + 1] < pt) k++;
    const d = times[k + 1] - times[k];
    const f = d > 0 ? (pt - times[k]) / d : 0;
    return L.latLng(
      lerp(pts[k].lat, pts[k + 1].lat, f),
      lerp(pts[k].lng, pts[k + 1].lng, f),
    );
  };

  const calcSpeed = (ft: number[]): number => {
    if (ft.length < 2) return 0;
    const dur = ft[ft.length - 1] - ft[0];
    return dur > 0 ? 1 / dur : 0;
  };

  // Gesamtlänge des Polyline berechnen (meters, annähernd)
  const pathLength = (pts: LatLng[]): number => {
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += pts[i - 1].distanceTo(pts[i]);
    }
    return total;
  };

  // progress (0..1) basierend auf tatsächlicher Wegstrecke
  const progressFrom = (loc: LatLng, pts: LatLng[]): number => {
    if (pts.length < 2) return 0;
    const totalLen = pathLength(pts);
    if (totalLen === 0) return 0;
    // Distanz vom Start bis zum nächstgelegenen Punkt kumuliert
    let distSoFar = 0;
    let closestDist = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = loc.distanceTo(pts[i]);
      if (d < closestDist) {
        closestDist = d;
      }
      if (i > 0) {
        distSoFar += pts[i - 1].distanceTo(pts[i]);
      }
    }
    return distSoFar / totalLen;
  };

  // Trail fuer einen Marker erstellen/aktualisieren
  const makeTrail = (s: State, pts: LatLng[], color: string): L.Polyline => {
    if (pts.length < 2) return L.polyline([]);
    // Dunkler Hintergrund -> leicht leuchtende Trails
    return L.polyline(pts, {
      color,
      weight: 3,
      opacity: 0.6,
      lineCap: "round",
      lineJoin: "round",
    }).addTo(mapInstance);
  };

  const make = (
    tid: string,
    mk: L.Marker,
    prod: string,
    nm: string,
    dir: string,
    pts: LatLng[],
    ft: number[],
    p: number,
  ): State => ({
    tripId: tid,
    marker: mk,
    lineProduct: prod,
    lineName: nm,
    direction: dir,
    polyline: pts,
    frameTimes: ft,
    progress: p,
    speed: calcSpeed(ft),
    lerping: false,
    lerpStart: 0,
    lerpFromLat: 0,
    lerpFromLng: 0,
    lerpToLat: 0,
    lerpToLng: 0,
    apiProgress: p,
    trail: null,
  });

  const setMapStyle = (style: MapStyle) => {
    if (style === currentStyle) return;
    currentStyle = style;
    tileLayer.setUrl(TILE_LAYERS[style]);
    const op = style === "dark" ? 0.35 : 0.4;
    states.forEach((s) => {
      if (s.trail) s.trail.setStyle({ opacity: op });
    });
  };

  const loop = () => {
    const now = performance.now();
    states.forEach((s) => {
      if (s.polyline.length < 2) return;

      if (s.lerping) {
        const elapsed = now - s.lerpStart;
        const t = Math.min(1, elapsed / LERP_MS);
        const eased = t * (2 - t);
        // Lerp die tatsächliche lat/lng Position
        const lat = lerp(s.lerpFromLat, s.lerpToLat, eased);
        const lng = lerp(s.lerpFromLng, s.lerpToLng, eased);
        s.marker.setLatLng([lat, lng]);
        if (t >= 1) {
          s.progress = s.apiProgress;
          s.lerping = false;
        }
      } else {
        s.progress += s.speed * 16;
        if (s.progress > 1) s.progress -= 1;
        if (s.progress < 0) s.progress += 1;
      }

      const pos = posAt(s.polyline, s.frameTimes, s.progress);
      if (pos) s.marker.setLatLng(pos);
    });
    rafId = states.size > 0 ? requestAnimationFrame(loop) : null;
  };

  const apply = (movements: any[]) => {
    const ids = new Set<string>();

    movements.forEach((m: any) => {
      const tid = m.tripId;
      ids.add(tid);
      const loc = L.latLng(m.location.latitude, m.location.longitude);
      const pts = (m.polyline?.features ?? []).map((f: any) =>
        L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]),
      );
      const ft = (m.frames ?? []).map((f: any) => f.t);
      const ep = progressFrom(loc, pts);
      const color = getTrailColor(m.line.product);

      if (states.has(tid)) {
        const s = states.get(tid)!;

        const same =
          s.polyline.length === pts.length &&
          s.polyline.every(
            (p, i) =>
              Math.abs(p.lat - pts[i].lat) < 1e-6 &&
              Math.abs(p.lng - pts[i].lng) < 1e-6,
          );

        const ns = calcSpeed(ft);
        if (ns > 0 && isFinite(ns)) s.speed = s.speed * 0.8 + ns * 0.2;

        if (same) {
          s.frameTimes = ft;
        } else {
          s.polyline = pts;
          s.frameTimes = ft;
        }

        // Stelle sicher dass jeder Marker einen Trail hat
        if (!s.trail) {
          s.trail = makeTrail(s, pts, color);
        } else if (!same) {
          // Pfad geaendert -> Trail aktualisieren
          s.trail.setLatLngs(pts);
        }

        // Smooth Lerp: Marker gleitet von aktueller Position zur API-Position
        // Smooth Lerp: Marker gleitet von aktueller lat/lng zur neuen API-Position
        const cur = s.marker.getLatLng();
        const newLoc = L.latLng(m.location.latitude, m.location.longitude);
        s.lerpFromLat = cur.lat;
        s.lerpFromLng = cur.lng;
        s.lerpToLat = newLoc.lat;
        s.lerpToLng = newLoc.lng;
        s.lerpStart = performance.now();
        s.lerping = true;
        s.apiProgress = ep;

        const np = m.line.product;
        const nn = m.line.name;
        if (s.lineProduct !== np || s.lineName !== nn) {
          s.marker.setIcon(getIcon(np, nn));
          s.lineProduct = np;
          s.lineName = nn;
          // Farbe geaendert -> Trail neu
          const newColor = getTrailColor(np);
          if (s.trail) s.trail.remove();
          s.trail = makeTrail(s, pts, newColor);
        }
        s.direction = m.direction;
        s.marker.setPopupContent(`<b>${m.line.name}</b><br>${m.direction}`);
      } else {
        const mk = L.marker(loc, {
          icon: getIcon(m.line.product, m.line.name),
        })
          .addTo(mapInstance)
          .bindPopup(`<b>${m.line.name}</b><br>${m.direction}`);
        const s = make(
          tid,
          mk,
          m.line.product,
          m.line.name,
          m.direction,
          pts,
          ft,
          ep,
        );
        s.trail = makeTrail(s, pts, color);
        states.set(tid, s);
      }
    });

    // Stale entfernen
    states.forEach((s) => {
      if (!ids.has(s.tripId)) {
        s.marker.remove();
        if (s.trail) s.trail.remove();
        states.delete(s.tripId);
      }
    });

    if (!rafId && states.size > 0) rafId = requestAnimationFrame(loop);
  };

  const pullData = async () => {
    const b = mapInstance.getBounds();
    const url =
      `https://v6.bvg.transport.rest/radar?north=${b.getNorth()}&west=${b.getWest()}` +
      `&south=${b.getSouth()}&east=${b.getEast()}` +
      `&duration=30&frames=30&results=1024`;
    const r = await globalThis.fetch(url);
    const j = await r.json();
    apply(j.movements);
  };

  const COLORS = {
    blue: "#3B82F6",
    pink: "#E8577A",
    yellow: "#F0D020",
    green: "#40C072",
    dark: "#1A1A1A",
  };

  const btnBase =
    "font-family:system-ui,-apple-system,sans-serif;" +
    "font-weight:900;font-size:18px;line-height:1;border:none;cursor:pointer;" +
    "width:44px;height:44px;display:flex;align-items:center;justify-content:center;" +
    "transition:background-color .15s,color .15s,transform .1s;";

  onMount(() => {
    mapInstance = L.map("map", {
      center: [52.5162, 13.3777],
      zoom: 12,
      zoomControl: false,
      attributionControl: true,
    });

    tileLayer = L.tileLayer(TILE_LAYERS[currentStyle], {
      minZoom: 14,
      attribution: TILE_ATTR,
    }).addTo(mapInstance);

    // Hide Leaflet attribution
    mapInstance.attributionControl?.remove();

    const container = mapInstance.getContainer();
    container.style.position = "relative";

    // Zoom controls — bold maxbeier.dev style with 4 accent colors
    const zoomWrap = document.createElement("div");
    zoomWrap.style.cssText =
      "position:absolute;top:16px;left:16px;z-index:1000;display:flex;flex-direction:column;gap:2px;";

    const makeColorBtn = (
      label: string,
      bg: string,
      color: string,
      hoverBg: string,
      borderRadius: string,
      onClick: () => void,
    ) => {
      const btn = document.createElement("button");
      btn.textContent = label;
      btn.style.cssText = btnBase + `background:${bg};color:${color};border-radius:${borderRadius};`;
      btn.addEventListener("mouseenter", () => {
        btn.style.backgroundColor = hoverBg;
        btn.style.transform = "scale(1.05)";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.backgroundColor = bg;
        btn.style.transform = "scale(1)";
      });
      btn.addEventListener("click", () => {
        btn.style.transform = "scale(0.95)";
        setTimeout(() => (btn.style.transform = "scale(1)"), 100);
        onClick();
      });
      return btn;
    };

    const zoomInBtn = makeColorBtn("+", COLORS.blue, "#fff", COLORS.dark, "22px 22px 0 0", () => mapInstance.zoomIn());
    const zoomOutBtn = makeColorBtn("−", COLORS.pink, "#fff", COLORS.dark, "0 0 22px 22px", () => mapInstance.zoomOut());
    zoomWrap.appendChild(zoomInBtn);
    zoomWrap.appendChild(zoomOutBtn);
    container.appendChild(zoomWrap);

    // Style-Toggle — custom SVG sun/moon with flip animation
    const styleBtn = document.createElement("button");
    styleBtn.style.cssText = btnBase + "position:absolute;top:16px;right:16px;z-index:1000;background:" + COLORS.yellow + ";color:" + COLORS.dark + ";border-radius:22px;overflow:hidden;";
    styleBtn.innerHTML = "";

    const sunSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="1" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.78" y2="4.22"/></svg>`;
    const moonSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

    let isDark = currentStyle === "dark";
    const iconEl = document.createElement("span");
    iconEl.style.cssText = "display:inline-block;transition:transform .3s cubic-bezier(.4,0,.2,1),opacity .2s;";
    iconEl.innerHTML = isDark ? sunSvg : moonSvg;
    styleBtn.appendChild(iconEl);

    const updateIcon = (dark: boolean) => {
      iconEl.style.transform = "rotate(-90deg)";
      iconEl.style.opacity = "0";
      setTimeout(() => {
        iconEl.innerHTML = dark ? sunSvg : moonSvg;
        iconEl.style.transform = "rotate(0deg)";
        iconEl.style.opacity = "1";
      }, 150);
    };

    styleBtn.addEventListener("mouseenter", () => {
      styleBtn.style.backgroundColor = COLORS.dark;
      styleBtn.style.color = COLORS.yellow;
      iconEl.style.transform = "rotate(10deg) scale(1.1)";
    });
    styleBtn.addEventListener("mouseleave", () => {
      styleBtn.style.backgroundColor = COLORS.yellow;
      styleBtn.style.color = COLORS.dark;
      iconEl.style.transform = "rotate(0deg) scale(1)";
    });
    styleBtn.addEventListener("click", () => {
      styleBtn.style.transform = "scale(0.95)";
      setTimeout(() => (styleBtn.style.transform = "scale(1)"), 100);
      isDark = !isDark;
      const next = isDark ? "dark" : "light";
      setMapStyle(next);
      updateIcon(isDark);
    });
    container.appendChild(styleBtn);

    pullData();
    const iv = setInterval(pullData, 12_000);

    onCleanup(() => {
      clearInterval(iv);
      if (rafId != null) cancelAnimationFrame(rafId);
      styleBtn.remove();
      zoomWrap.remove();
      states.forEach((s) => {
        if (s.trail) s.trail.remove();
      });
      mapInstance.remove();
      states.clear();
    });
  });

  return <div id="map" class="w-full h-full" style="height:100vh" />;
};

export default BerlinMap;
