import L, { icon, LatLng } from "leaflet";
import "leaflet/dist/leaflet.css";
import { onCleanup, onMount } from "solid-js";

interface VehicleAnimState {
  tripId: string;
  marker: L.Marker;
  polyline: LatLng[];
  frameTimes: number[];
  pathTimeAtLastUpdate: number;
  lastApiUpdateTime: number;
  lineProduct: string;
  lineName: string;
}

const BerlinMap = () => {
  let mapInstance: L.Map;
  const vehicleStates = new Map<string, VehicleAnimState>();
  let animationFrameRequestId: number | null = null;

  const getIcon = (lineProduct: string, lineName: string) => {
    let iconUrl: string;
    switch (lineProduct) {
      case "bus":
        iconUrl = "img/icons/bvg/bus.svg";
        break;
      case "ferry":
        iconUrl = "img/icons/bvg/ferry.svg";
        break;
      case "express":
        iconUrl = "img/icons/bvg/express.svg";
        break;
      case "regional":
        iconUrl = "img/icons/bvg/regional.svg";
        break;
      default:
        iconUrl = `img/icons/bvg/${lineProduct}/${lineName}.svg`;
        break;
    }
    return icon({
      iconUrl,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -12],
    });
  };

  const animationLoop = (currentTime: number) => {
    vehicleStates.forEach((state) => {
      if (
        state.polyline.length < 2 ||
        state.frameTimes.length < 2 ||
        state.polyline.length !== state.frameTimes.length
      ) {
        // Not enough data for path animation or data mismatch
        // Marker position is set by drawMarkersAndManageStates based on API's movement.location
        return;
      }

      const timeElapsedSinceLastUpdate = currentTime - state.lastApiUpdateTime;
      const currentPathTime =
        state.pathTimeAtLastUpdate + timeElapsedSinceLastUpdate;

      let interpolatedPos: LatLng;

      if (currentPathTime < state.frameTimes[0]) {
        interpolatedPos = state.polyline[0];
      } else if (
        currentPathTime >= state.frameTimes[state.frameTimes.length - 1]
      ) {
        interpolatedPos = state.polyline[state.polyline.length - 1];
      } else {
        let k = -1; // Index for the start of the segment
        for (let i = 0; i < state.frameTimes.length - 1; i++) {
          if (
            state.frameTimes[i] <= currentPathTime &&
            currentPathTime < state.frameTimes[i + 1]
          ) {
            k = i;
            break;
          }
        }

        if (k === -1) {
          // Should be caught by earlier checks, but as a fallback:
          // If currentPathTime is somehow between the last two points after the >= check failed for the last point.
          if (
            state.frameTimes.length >= 2 &&
            currentPathTime >= state.frameTimes[state.frameTimes.length - 2]
          ) {
            k = state.frameTimes.length - 2;
          } else {
            // Fallback to the start or end of the polyline if segment not found
            interpolatedPos =
              currentPathTime < state.frameTimes[0]
                ? state.polyline[0]
                : state.polyline[state.polyline.length - 1];
            state.marker.setLatLng(interpolatedPos);
            return;
          }
        }

        const t0 = state.frameTimes[k];
        const t1 = state.frameTimes[k + 1];
        const p0 = state.polyline[k];
        const p1 = state.polyline[k + 1];

        const segmentDuration = t1 - t0;
        const timeIntoSegment = currentPathTime - t0;

        const segmentProgress =
          segmentDuration > 0 ? timeIntoSegment / segmentDuration : 0;
        const clampedProgress = Math.max(0, Math.min(1, segmentProgress));

        const lat = p0.lat + (p1.lat - p0.lat) * clampedProgress;
        const lng = p0.lng + (p1.lng - p0.lng) * clampedProgress;
        interpolatedPos = L.latLng(lat, lng);
      }
      state.marker.setLatLng(interpolatedPos);
    });

    if (vehicleStates.size > 0) {
      animationFrameRequestId = requestAnimationFrame(animationLoop);
    } else {
      animationFrameRequestId = null;
    }
  };

  const drawMarkersAndManageStates = (
    movements: any[],
    apiReceiveTime: number,
  ) => {
    const currentTripIds = new Set<string>();

    movements.forEach((m) => {
      const tripId = m.tripId;
      currentTripIds.add(tripId);

      const currentLocation = L.latLng(
        m.location.latitude,
        m.location.longitude,
      );
      const polylinePts =
        m.polyline?.features.map((f: any) =>
          L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]),
        ) || [];
      const frameTs = m.frames?.map((f: any) => f.t) || [];

      let estimatedPathTime = 0;
      if (polylinePts.length > 0 && frameTs.length === polylinePts.length) {
        let closestPtIdx = 0;
        let minDistSq = Infinity;
        polylinePts.forEach((pt, idx) => {
          const dSq = currentLocation.distanceTo(pt) ** 2;
          if (dSq < minDistSq) {
            minDistSq = dSq;
            closestPtIdx = idx;
          }
        });
        if (frameTs.length > closestPtIdx) {
          estimatedPathTime = frameTs[closestPtIdx];
        } else if (frameTs.length > 0) {
          // Fallback if closestPtIdx is out of bounds for frameTs (should not happen if lengths match)
          estimatedPathTime = frameTs[frameTs.length - 1];
        }
      } else if (polylinePts.length === 1 && frameTs.length === 1) {
        // Single point polyline, common when at a stop.
        estimatedPathTime = frameTs[0];
      }

      if (vehicleStates.has(tripId)) {
        const state = vehicleStates.get(tripId)!;
        state.polyline = polylinePts;
        state.frameTimes = frameTs;
        state.pathTimeAtLastUpdate = estimatedPathTime;
        state.lastApiUpdateTime = apiReceiveTime;

        const newProduct = m.line.product;
        const newName = m.line.name;
        if (state.lineProduct !== newProduct || state.lineName !== newName) {
          state.marker.setIcon(getIcon(newProduct, newName));
          state.lineProduct = newProduct;
          state.lineName = newName;
        }
        state.marker.setPopupContent(`<b>${m.line.name}</b><br>${m.direction}`);
        // Ensure marker is at the exact API location if not animating or polyline is empty
        if (polylinePts.length < 2) {
          state.marker.setLatLng(currentLocation);
        }
      } else {
        const markerInstance = L.marker(currentLocation, {
          icon: getIcon(m.line.product, m.line.name),
        })
          .addTo(mapInstance)
          .bindPopup(`<b>${m.line.name}</b><br>${m.direction}`);

        vehicleStates.set(tripId, {
          tripId,
          marker: markerInstance,
          polyline: polylinePts,
          frameTimes: frameTs,
          pathTimeAtLastUpdate: estimatedPathTime,
          lastApiUpdateTime: apiReceiveTime,
          lineProduct: m.line.product,
          lineName: m.line.name,
        });
      }
    });

    vehicleStates.forEach((state) => {
      if (!currentTripIds.has(state.tripId)) {
        state.marker.remove();
        vehicleStates.delete(state.tripId);
      }
    });

    if (!animationFrameRequestId && vehicleStates.size > 0) {
      animationFrameRequestId = requestAnimationFrame(animationLoop);
    }
  };

  const fetchData = async () => {
    const bbox = mapInstance.getBounds();
    const north = bbox.getNorth();
    const west = bbox.getWest();
    const south = bbox.getSouth();
    const east = bbox.getEast();

    const duration = 15; // Adjusted from 30
    const frame_count = 30; // Adjusted from 10
    const results = 1024;

    const res = await fetch(
      `https://v6.bvg.transport.rest/radar?north=${north}&west=${west}` +
        `&south=${south}&east=${east}&duration=${duration}&frames=${frame_count}&results=${results}`,
    );
    const json = await res.json();
    const apiReceiveTime = performance.now();
    drawMarkersAndManageStates(json.movements, apiReceiveTime);
  };

  onMount(() => {
    mapInstance = L.map("map", {
      center: [52.5162, 13.3777],
      zoom: 12,
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      minZoom: 14, // Consider allowing more zoom out to see broader movements
      attribution:
        '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(mapInstance);

    fetchData();

    const interval = setInterval(fetchData, 5_000); // Adjusted from 2_000

    onCleanup(() => {
      clearInterval(interval);
      if (animationFrameRequestId !== null) {
        cancelAnimationFrame(animationFrameRequestId);
        animationFrameRequestId = null;
      }
      mapInstance.remove();
      vehicleStates.clear();
    });
  });

  return <div id="map" class="w-full h-full" style="height:100vh" />;
};

export default BerlinMap;
