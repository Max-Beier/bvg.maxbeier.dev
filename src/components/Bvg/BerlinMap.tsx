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
  trailHistory: LatLng[];
  lastTrailTime: number;
  trailFade: boolean;
  operator: string;
  nextStopovers: any[];
  frames: any[];
}

const LERP_MS = 1000;
const TRAIL_FADE_MS = 8000;
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

  // Info panel
  let infoPanel: HTMLDivElement | null = null;
  let infoPanelTarget: State | null = null;
  let infoPanelVisible = false;
  let infoFollowState: State | null = null;

  // Geolocation
  let locationMarker: L.Marker | null = null;
  let locationCircle: L.CircleMarker | null = null;

  const getIcon = (product: string, name: string) => {
    const key = `${product}/${name}`;
    const c = iconCache.get(key);
    if (c) return c;
    let url: string;
    switch (product) {
      case "bus": url = "img/icons/bvg/bus.svg"; break;
      case "ferry": url = "img/icons/bvg/ferry.svg"; break;
      case "express": url = "img/icons/bvg/express.svg"; break;
      case "regional": url = "img/icons/bvg/regional.svg"; break;
      default: url = `img/icons/bvg/${product}/${name}.svg`;
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

  const productLabel = (prod: string): string => {
    const labels: Record<string, string> = {
      subway: "U-Bahn", suburban: "S-Bahn", tram: "Tram", bus: "Bus",
      ferry: "Fähre", express: "Fernzug", regional: "Regional",
    };
    return labels[prod] ?? prod;
  };

  const fmtTime = (iso: string | null): string => {
    if (!iso) return "--";
    const d = new Date(iso);
    return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  };

  const fmtDelay = (sec: number | null): string => {
    if (!sec || sec <= 0) return "";
    return `+${Math.round(sec / 60)} min`;
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

  const pathLength = (pts: LatLng[]): number => {
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      total += pts[i - 1].distanceTo(pts[i]);
    }
    return total;
  };

  const progressFrom = (loc: LatLng, pts: LatLng[]): number => {
    if (pts.length < 2) return 0;
    const totalLen = pathLength(pts);
    if (totalLen === 0) return 0;
    let distSoFar = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = loc.distanceTo(pts[i]);
      const segLen = pts[i].distanceTo(pts[i + 1]);
      if (d <= segLen * 0.5) {
        return (distSoFar + d) / totalLen;
      }
      distSoFar += segLen;
    }
    return 1;
  };

  const makeTrail = (_s: State, pts: LatLng[], color: string): L.Polyline => {
    return L.polyline(pts, {
      color, weight: 3, opacity: 0.6, lineCap: "round", lineJoin: "round",
    }).addTo(mapInstance);
  };

  const make = (
    tid: string, mk: L.Marker, prod: string, nm: string, dir: string,
    pts: LatLng[], ft: number[], p: number,
  ): State => ({
    tripId: tid, marker: mk, lineProduct: prod, lineName: nm, direction: dir,
    polyline: pts, frameTimes: ft, progress: p, speed: calcSpeed(ft),
    lerping: false, lerpStart: 0, lerpFromLat: 0, lerpFromLng: 0,
    lerpToLat: 0, lerpToLng: 0, apiProgress: p, trail: null,
    trailHistory: [], lastTrailTime: 0, trailFade: true,
    operator: "", nextStopovers: [], frames: [],
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

  const createLocationMarker = () => {
    const locIcon = L.divIcon({
      className: "", iconSize: [16, 16], iconAnchor: [8, 8],
      html: `<div style="width:16px;height:16px;border-radius:50%;background:#3B82F6;border:3px solid #fff;box-shadow:0 0 8px rgba(59,130,246,0.6);"></div>`,
    });
    locationMarker = L.marker([0, 0], { icon: locIcon, zIndexOffset: 1000 }).addTo(mapInstance);
    locationMarker.setOpacity(0);
    locationCircle = L.circleMarker([0, 0], {
      radius: 12, color: "#3B82F6", fillColor: "#3B82F6", fillOpacity: 0.15, weight: 0, interactive: false,
    }).addTo(mapInstance);
    locationCircle.setStyle({ fillOpacity: 0, opacity: 0 });
    if (navigator.geolocation) navigator.geolocation.watchPosition(updateLocation);
  };

  const updateLocation = (pos: GeolocationPosition) => {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const latlng: L.LatLngExpression = [lat, lng];
    if (locationMarker) locationMarker.setLatLng(latlng);
    if (locationCircle) locationCircle.setLatLng(latlng);
    if (pos.coords.accuracy) {
      locationCircle?.setRadius(Math.min(pos.coords.accuracy / 10, 30));
    }
  };

  // Info panel logic
  const openInfoPanel = (s: State) => {
    if (!infoPanel || !mapInstance) return;

    infoPanelTarget = s;
    infoPanelVisible = true;
    // Follow nicht stoppen wenn man ein anderes Fahrzeug anklickt

    const color = getTrailColor(s.lineProduct);
    const label = productLabel(s.lineProduct);
    const stops = (s.nextStopovers || []).filter((st: any) => {
      const time = st.arrival ?? st.departure;
      if (!time) return true;
      return new Date(time) >= new Date();
    });
    const frames = s.frames || [];
    const origin = frames[0]?.origin?.name ?? "";
    const dest = frames[0]?.destination?.name ?? "";

    const stopRows = stops.slice(0, 5).map((st: any) => {
      const name = st.stop?.name ?? "";
      const arr = fmtTime(st.arrival ?? st.departure ?? null);
      const delay = fmtDelay(st.arrivalDelay ?? st.departureDelay ?? 0);
      const platform = st.arrivalPlatform ?? st.departurePlatform ?? "";
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid rgba(128,128,128,0.12);">
        <span style="color:#fff;font-size:15px;font-weight:800;min-width:44px;">${arr}</span>
        ${platform ? `<span style="background:rgba(255,255,255,0.1);color:#fff;font-size:11px;font-weight:700;padding:3px 8px;border-radius:10px;">${platform}</span>` : ""}
        <span style="color:rgba(255,255,255,0.85);font-size:13px;flex:1;">${name}</span>
        ${delay ? `<span style="color:#E8577A;font-size:11px;font-weight:700;">${delay}</span>` : ""}
      </div>`;
    }).join("");

    infoPanel.innerHTML = `
      <div style="padding:18px 22px 20px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
          <span style="background:${color};color:#fff;font-size:14px;font-weight:900;padding:5px 12px;border-radius:8px;">${s.lineName}</span>
          <span style="color:rgba(255,255,255,0.5);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">${label}</span>
          <span style="color:rgba(255,255,255,0.35);font-size:11px;margin-left:auto;">${s.operator}</span>
          <button class="info-close" style="width:26px;height:26px;border-radius:13px;border:none;cursor:pointer;background:rgba(255,255,255,0.1);color:#fff;font-size:15px;display:flex;align-items:center;justify-content:center;font-weight:900;line-height:1;flex-shrink:0;margin-left:6px;">&times;</button>
        </div>
        <div style="color:rgba(255,255,255,0.7);font-size:13px;font-weight:600;margin-bottom:12px;">
          &rarr; ${s.direction}
        </div>
        ${origin || dest ? `<div style="display:flex;align-items:center;gap:8px;color:rgba(255,255,255,0.4);font-size:12px;font-weight:600;margin-bottom:14px;">
          <span>${origin}</span><span style="color:rgba(255,255,255,0.15);">—</span><span>${dest}</span>
        </div>` : ""}
        ${stopRows ? `
          <div style="color:rgba(255,255,255,0.35);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Next stops</div>
          ${stopRows}
        ` : ""}
        <button class="info-follow" style="width:100%;margin-top:14px;padding:10px 0;border-radius:10px;border:none;cursor:pointer;background:rgba(59,130,246,0.15);color:#3B82F6;font-size:13px;font-weight:800;font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;gap:6px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>
          Follow
        </button>
      </div>
    `;

    infoPanel.style.display = "block";

    const closeBtn = infoPanel.querySelector(".info-close") as HTMLButtonElement;
    closeBtn?.addEventListener("mouseenter", () => (closeBtn.style.backgroundColor = "rgba(255,255,255,0.2)"));
    closeBtn?.addEventListener("mouseleave", () => (closeBtn.style.backgroundColor = "rgba(255,255,255,0.1)"));
    closeBtn?.addEventListener("click", () => {
      infoPanelVisible = false;
      infoPanelTarget = null;
      // Follow nicht stoppen — nur Panel schliessen
      infoPanel!.style.display = "none";
    });
    const followBtn = infoPanel.querySelector(".info-follow") as HTMLButtonElement;
    const updateFollowBtn = () => {
      const following = infoFollowState === s;
      followBtn.innerHTML = following
        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg> Following`
        : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg> Follow`;
      followBtn.style.backgroundColor = following ? "rgba(59,130,246,0.3)" : "rgba(59,130,246,0.15)";
      followBtn.style.color = following ? "#fff" : "#3B82F6";
    };
    updateFollowBtn();
    followBtn?.addEventListener("mousedown", (e) => e.stopPropagation());
    followBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (infoFollowState === s) {
        infoFollowState = null;
      } else {
        infoFollowState = s;
        mapInstance.panTo(s.marker.getLatLng(), { noMoveStart: true });
      }
      updateFollowBtn();
    });
    followBtn?.addEventListener("mouseenter", () => (followBtn.style.backgroundColor = "rgba(59,130,246,0.25)"));
    followBtn?.addEventListener("mouseleave", () => (followBtn.style.backgroundColor = "rgba(59,130,246,0.15)"));
  };

  const updateInfoPanelPosition = () => {
    if (!infoPanelVisible || !infoPanelTarget || !mapInstance || !infoPanel) return;
    const point = infoPanelTarget.marker.getLatLng();
    const containerPoint = mapInstance.latLngToContainerPoint(point);
    const containerRect = mapInstance.getContainer().getBoundingClientRect();

    const panelW = 320;
    const panelH = 360;

    let left = containerPoint.x - panelW / 2;
    let top = containerPoint.y - panelH - 24;

    if (left < 10) left = 10;
    if (left + panelW > containerRect.width - 10) left = containerRect.width - panelW - 10;
    if (top < 10) top = containerPoint.y + 28;

    infoPanel.style.left = left + "px";
    infoPanel.style.top = top + "px";
  };

  const loop = () => {
    const now = performance.now();
    states.forEach((s) => {
      if (s.polyline.length < 2) return;

      if (s.lerping) {
        const elapsed = now - s.lerpStart;
        const t = Math.min(1, elapsed / LERP_MS);
        const eased = t * (2 - t);
        const lat = lerp(s.lerpFromLat, s.lerpToLat, eased);
        const lng = lerp(s.lerpFromLng, s.lerpToLng, eased);
        s.marker.setLatLng([lat, lng]);
        s.trailHistory.push(L.latLng(lat, lng));
        s.lastTrailTime = now;
        if (t >= 1) {
          s.progress = s.apiProgress;
          s.lerping = false;
        }
      } else {
        s.progress += s.speed * 16;
        if (s.progress > 1) s.progress -= 1;
        if (s.progress < 0) s.progress += 1;
        const pos = posAt(s.polyline, s.frameTimes, s.progress);
        if (pos) {
          s.marker.setLatLng(pos);
          s.trailHistory.push(pos);
          s.lastTrailTime = now;
        }
      }

      if (s.trail && s.trailHistory.length >= 2) {
        const maxPts = Math.ceil(TRAIL_FADE_MS / 16);
        if (s.trailHistory.length > maxPts) {
          s.trailHistory = s.trailHistory.slice(-maxPts);
        }
        s.trail.setLatLngs(s.trailHistory);
        if (s.trailFade) {
          const age = now - s.lastTrailTime;
          const fade = Math.max(0, 1 - age / TRAIL_FADE_MS);
          s.trail.setStyle({ opacity: 0.2 + fade * 0.4 });
        }
      }
    });

    if (infoPanelVisible) updateInfoPanelPosition();
    // Update follow button state in panel
    if (infoPanelVisible && infoPanelTarget && infoPanel) {
      const fb = infoPanel.querySelector(".info-follow") as HTMLButtonElement;
      if (fb) {
        const following = infoFollowState === infoPanelTarget;
        fb.innerHTML = following
          ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg> Following`
          : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg> Follow`;
        fb.style.backgroundColor = following ? "rgba(59,130,246,0.3)" : "rgba(59,130,246,0.15)";
        fb.style.color = following ? "#fff" : "#3B82F6";
      }
    }

    // Follow vehicle
    if (infoFollowState && mapInstance) {
      const pt = infoFollowState.marker.getLatLng();
      mapInstance.panTo(pt, { animate: false, noMoveStart: true });
    }

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

        if (!s.trail) {
          s.trail = makeTrail(s, [], color);
        }

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
          const newColor = getTrailColor(np);
          if (s.trail) s.trail.remove();
          s.trail = makeTrail(s, s.trailHistory, newColor);
        }
        s.direction = m.direction;
        s.operator = m.line.operator?.name ?? "";
        s.nextStopovers = m.nextStopovers ?? [];
        s.frames = m.frames ?? [];
        s.marker.off("click");
        s.marker.on("click", () => openInfoPanel(s));
      } else {
        const mk = L.marker(loc, {
          icon: getIcon(m.line.product, m.line.name),
        }).addTo(mapInstance);
        mk.on("click", () => {
          const s = states.get(tid);
          if (s) openInfoPanel(s);
        });
        const s = make(
          tid, mk, m.line.product, m.line.name, m.direction, pts, ft, ep,
        );
        s.trail = makeTrail(s, [], color);
        s.trailHistory = [];
        s.operator = m.line.operator?.name ?? "";
        s.nextStopovers = m.nextStopovers ?? [];
        s.frames = m.frames ?? [];
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

    mapInstance.attributionControl?.remove();

    const container = mapInstance.getContainer();
    container.style.position = "relative";

    // Zoom controls
    const zoomWrap = document.createElement("div");
    zoomWrap.style.cssText =
      "position:absolute;top:16px;left:16px;z-index:1000;display:flex;flex-direction:column;gap:2px;";

    const makeColorBtn = (
      label: string, bg: string, color: string, hoverBg: string,
      borderRadius: string, onClick: () => void,
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
    const zoomOutBtn = makeColorBtn("\u2212", COLORS.pink, "#fff", COLORS.dark, "0 0 22px 22px", () => mapInstance.zoomOut());
    zoomWrap.appendChild(zoomInBtn);
    zoomWrap.appendChild(zoomOutBtn);
    container.appendChild(zoomWrap);

    // Style-Toggle
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

    // Info panel overlay
    infoPanel = document.createElement("div");
    infoPanel.style.cssText =
      "position:absolute;top:16px;left:50%;transform:translateX(-50%);z-index:1000;" +
      "width:320px;max-height:80vh;overflow-y:auto;" +
      "background:rgba(20,20,20,0.92);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);" +
      "border:1px solid rgba(255,255,255,0.1);border-radius:16px;" +
      "font-family:system-ui,-apple-system,sans-serif;color:#fff;" +
      "display:none;box-shadow:0 8px 32px rgba(0,0,0,0.4);";
    container.appendChild(infoPanel);
    L.DomEvent.disableClickPropagation(infoPanel);
    L.DomEvent.disableScrollPropagation(infoPanel);

    // Location button
    const locOffSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>`;
    const locOnSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>`;
    let locActive = false;
    const locBtn = document.createElement("button");
    const locOff = "#666";
    locBtn.style.cssText = btnBase + "position:absolute;bottom:16px;left:16px;z-index:1000;background:" + locOff + ";color:#fff;border-radius:22px;";
    locBtn.innerHTML = locOffSvg;
    const toggleLocActive = () => {
      locActive = !locActive;
      if (locActive) {
        locBtn.style.backgroundColor = COLORS.blue;
        locBtn.innerHTML = locOnSvg;
        if (!locationMarker) {
          createLocationMarker();
        }
        locationMarker!.setOpacity(1);
        locationCircle?.setStyle({ fillOpacity: 0.15, opacity: 0.5 });
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              updateLocation(pos);
              if (infoFollowState) infoFollowState = null;
              mapInstance.flyTo([pos.coords.latitude, pos.coords.longitude], 15, { duration: 2 });
            },
            () => { /* no access */ },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
          );
        }
      } else {
        locBtn.style.backgroundColor = locOff;
        locBtn.innerHTML = locOffSvg;
        if (locationMarker) locationMarker.setOpacity(0);
        if (locationCircle) locationCircle.setStyle({ fillOpacity: 0, opacity: 0 });
      }
    };
    locBtn.addEventListener("mouseenter", () => {
      locBtn.style.backgroundColor = locActive ? COLORS.dark : "#888";
      locBtn.style.transform = "scale(1.05)";
    });
    locBtn.addEventListener("mouseleave", () => {
      locBtn.style.backgroundColor = locActive ? COLORS.blue : locOff;
      locBtn.style.transform = "scale(1)";
    });
    locBtn.addEventListener("click", () => {
      locBtn.style.transform = "scale(0.95)";
      setTimeout(() => (locBtn.style.transform = "scale(1)"), 100);
      toggleLocActive();
    });
    container.appendChild(locBtn);

    pullData();
    const iv = setInterval(pullData, 12_000);

    // User pannet -> Follow stoppen
    mapInstance.on("dragstart", () => {
      if (infoFollowState) infoFollowState = null;
    });

    onCleanup(() => {
      clearInterval(iv);
      if (rafId != null) cancelAnimationFrame(rafId);
      styleBtn.remove();
      zoomWrap.remove();
      locBtn.remove();
      infoPanel?.remove();
      if (locationMarker) locationMarker.remove();
      if (locationCircle) locationCircle.remove();
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
